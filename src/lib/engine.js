// The pure decision core.
//
// Zero browser APIs, no clock of its own, no randomness, fully synchronous.
// The clock arrives as `input.now`, which is what turns every race in the
// failure catalogue into an ordinary table-driven test case rather than a
// timing experiment.
//
// The ladder is documented in docs/architecture.md and the reasoning per rung
// in docs/adr/. Read those before changing an order here: the ORDER is the
// design, and three of the failures in the catalogue are what happens when a
// rule is consulted one step too early.

export const VERSION = '1.0.0';

/** Rungs, named rather than numbered inline so a log line can be read aloud. */
export const RUNG = {
  GATE: 0,
  CLAIM: 1,
  INHERIT: 2,
  SHAPE: 3,
  RULE: 4,
  ASK: 5,
  LEAVE: 6,
};

const leave = (rung, reason, extra) => ({ action: 'leave', rung, reason, ...extra });

/** Only ordinary web pages can be reopened meaningfully. */
export function isInterceptable(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A host matches a pattern, and so does any subdomain of it.
 *
 * Deliberately not globs: a wrong glob silently widens a rule, and the whole
 * point of this extension is that silence is never the answer to "why did that
 * happen".
 */
export function hostMatches(host, pattern) {
  const p = String(pattern ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '');
  if (!p || !host) return false;
  return host === p || host.endsWith(`.${p}`);
}

const onAnyHost = (host, patterns) =>
  (Array.isArray(patterns) ? patterns : []).some((p) => hostMatches(host, p));

/** Does a compiled rule match this request? */
function ruleMatches(rule, url, host) {
  const m = rule?.match;
  if (!m) return false;
  if (typeof m.regex === 'string') {
    try {
      return new RegExp(m.regex).test(url);
    } catch {
      // A regex that does not compile is a config error the compiler should
      // have refused. Here it simply never matches — an unmatched rule leaves
      // the tab alone, which is the safe direction.
      return false;
    }
  }
  if (typeof m.host === 'string') {
    if (!hostMatches(host, m.host)) return false;
    if (typeof m.path === 'string') {
      try {
        return new URL(url).pathname.startsWith(m.path);
      } catch {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * The entry shape, with a band in the middle where nobody acts.
 *
 * linkward classifies entries too, and if the two disagree at the boundary both
 * may act on one request — with no ordering guarantee between blocking
 * listeners. So commander needs the WIDER margin before it will call something
 * internal, and the disagreement band resolves to silence in both.
 */
export function entryShape({ focusedSince, at, graceMs, marginMs }) {
  if (!Number.isFinite(focusedSince)) return 'external';
  const age = at - focusedSince;
  if (age <= graceMs) return 'external';
  if (age > graceMs + marginMs) return 'internal';
  return 'ambiguous';
}

/**
 * Does a rule apply to this entry shape?
 *
 * `any` exists because most host rules genuinely mean both: an internal team
 * tool belongs in the same container whether you typed its address or a
 * colleague sent you a link. Without it every such rule has to be written
 * twice, and a pair of rules that drifts apart is precisely the class of bug
 * this extension exists to prevent.
 *
 * It is still EXPLICIT — there is no default scope — because the thing worth
 * refusing is a rule whose author never thought about the question.
 */
function inScope(rule, shape) {
  return rule?.scope === shape || rule?.scope === 'any';
}

/** The bare-host pin the compiler refuses; refused again here, in depth. */
function isBareAuthPin(rule, authHosts) {
  return typeof rule?.match?.host === 'string' && onAnyHost(rule.match.host, authHosts);
}

/**
 * @param {object} input see docs/architecture.md §14
 * @returns {{action: 'leave'|'reopen'|'ask', rung: number, reason?: string}}
 */
export function decide(input) {
  try {
    return run(input);
  } catch (err) {
    // This runs inside a blocking listener. A thrown error here is holding up
    // somebody's page, so the last line of defence is to behave as if the
    // extension were not installed.
    return leave(RUNG.LEAVE, `error:${err?.message ?? 'unknown'}`);
  }
}

function run(input) {
  if (!input || typeof input !== 'object') return leave(RUNG.LEAVE, 'no-input');

  const { request, tab, candidate, claims, focus, containers, now } = input;
  const config = input.config;

  // Bound tabs first, before ANY gate. A tab a peer owns is hands-off for its
  // whole life, and its first request is long spent by the time it browses on.
  if (claims?.boundToTab) return leave(RUNG.CLAIM, 'claim:bound');

  // --- GATE 0 — is this ours to have an opinion about at all? --------------
  if (!request || typeof request !== 'object') return leave(RUNG.GATE, 'no-request');

  const method = String(request.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    // Reopening is close-and-create, and tabs.create takes only a URL — the
    // body would be gone. Logged, never silently swallowed: a deterministic
    // route that quietly does not fire is indistinguishable from a broken one.
    return leave(RUNG.GATE, `method:${method}`);
  }

  if (!isInterceptable(request.url)) return leave(RUNG.GATE, 'scheme');

  if (!config || typeof config !== 'object') return leave(RUNG.GATE, 'no-config');
  if (config.invalid) return leave(RUNG.GATE, 'config-invalid');

  const since = candidate?.since;
  if (!Number.isFinite(since)) return leave(RUNG.GATE, 'not-a-candidate');
  if (candidate?.spent) return leave(RUNG.GATE, 'already-decided');

  const freshMs = Number.isFinite(config.freshMs) ? config.freshMs : 5000;
  if (now - since >= freshMs) return leave(RUNG.GATE, 'stale');

  const verdict = ladder(input, { config, request, tab, claims, focus, containers, since });

  // dryRun keeps the opinion and drops the enforcement, which is what makes the
  // migration soak safe: nothing moves, but the log says what would have.
  if (config.dryRun && verdict.action !== 'leave') {
    return leave(RUNG.GATE, 'dry-run', { wouldHave: verdict });
  }
  return verdict;
}

function ladder(input, ctx) {
  const { config, request, tab, claims, focus, containers, since } = ctx;

  // --- RUNG 1 — claims -----------------------------------------------------
  if (claims?.pendingMatch) return leave(RUNG.CLAIM, 'claim:pending');

  // --- RUNG 2 — inheritance (this rung IS "auth follows caller") -----------
  // Evaluated before a single rule is read, so a redirect can never meet one.
  if (request.originUrl || request.documentUrl) return leave(RUNG.INHERIT, 'started-by-document');
  if (tab?.openerTabId !== undefined && tab?.openerTabId !== null) {
    return leave(RUNG.INHERIT, 'has-opener');
  }
  const store = tab?.cookieStoreId;
  const chosenByHand = typeof store === 'string' && store !== '' && store !== 'firefox-default';
  if (chosenByHand) return leave(RUNG.INHERIT, 'user-container-entry');

  // --- RUNG 3 — entry shape ------------------------------------------------
  const graceMs = Number.isFinite(config.focusGraceMs) ? config.focusGraceMs : 1500;
  const marginMs = Number.isFinite(config.internalMarginMs) ? config.internalMarginMs : graceMs;
  const shape = entryShape({ focusedSince: focus?.focusedSince, at: since, graceMs, marginMs });
  if (shape === 'ambiguous') return leave(RUNG.SHAPE, 'shape-ambiguous');

  const url = request.url;
  const host = hostOf(url);

  if (onAnyHost(host, config.never)) return leave(RUNG.RULE, 'never-host');

  // Two extensions running two revisions of one jurisdiction fact is the
  // confirm-page race with better manners, so external enforcement stands down
  // until the peers agree about which policy they are both following.
  const skewed = (config.peers ?? []).some((p) => p?.revision && p.revision !== config.revision);
  if (shape === 'external' && skewed) return leave(RUNG.RULE, 'peer-revision-skew');

  // --- RUNG 4 — entry rules (first match, compiler-ordered) ----------------
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const match = rules.find(
    (r) => inScope(r, shape) && ruleMatches(r, url, host) && !isBareAuthPin(r, config.authHosts),
  );

  const hints = usableHints(input.bookmarkHits, host, config);

  if (match) {
    // Asking on an outside hand-off is linkward's monopoly. The compiler
    // refuses this config; the engine refuses it again, in depth.
    if (match.to === 'ask') {
      // Only an INTERNAL rule may ask. `any` includes outside links, and those
      // belong to linkward — two pickers on one territory is the confirm-page
      // race, rebuilt deliberately out of our own parts. The compiler refuses
      // this config; the engine refuses it again, in depth.
      if (match.scope !== 'internal') return leave(RUNG.RULE, 'ask-not-allowed-on-external');
      return ask(containers, match.id, hints[0]?.container);
    }
    const target = (containers ?? []).find((c) => c.name === match.to);
    if (!target) return leave(RUNG.RULE, `unknown-container:${match.to}`);
    return {
      action: 'reopen',
      cookieStoreId: target.cookieStoreId,
      container: target.name,
      ruleId: match.id,
      rung: RUNG.RULE,
      suppressedHints: hints,
    };
  }

  // --- Bookmark hints — the weakest tier, and only on internal entries -----
  if (shape === 'internal' && hints.length) {
    const distinct = new Set(hints.map((h) => h.container));
    if (distinct.size > 1) {
      if (config.bookmarks?.onConflict === 'ask') return ask(containers, 'bookmark-conflict');
      return leave(RUNG.LEAVE, 'bookmark-conflict');
    }
    const target = (containers ?? []).find((c) => c.name === hints[0].container);
    if (!target) return leave(RUNG.LEAVE, `unknown-container:${hints[0].container}`);
    return {
      action: 'reopen',
      cookieStoreId: target.cookieStoreId,
      container: target.name,
      ruleId: `bookmark:${hints[0].folderPath}`,
      rung: RUNG.RULE,
      suppressedHints: [],
    };
  }

  // --- RUNG 6 — leave alone, a named rung and not an else-branch -----------
  return leave(RUNG.LEAVE, 'no-match');
}

/**
 * Hints that survive the two filters.
 *
 * A console deep link or a bare sign-in URL filed in a mapped folder must not
 * become a silent route into the wrong account — that is the unroutable-host
 * failure arriving through the bookmarks tree, and it was found by attacking
 * the design rather than by using it.
 */
function usableHints(bookmarkHits, host, config) {
  const hits = Array.isArray(bookmarkHits) ? bookmarkHits : [];
  if (!hits.length) return [];
  if (onAnyHost(host, config.never) || onAnyHost(host, config.authHosts)) return [];
  return hits;
}

function ask(containers, ruleId, preselect) {
  return {
    action: 'ask',
    choices: (containers ?? []).map((c) => ({ name: c.name, cookieStoreId: c.cookieStoreId })),
    preselect,
    ruleId,
    rung: RUNG.ASK,
    reason: 'configured-ask',
  };
}
