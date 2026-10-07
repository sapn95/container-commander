// Who else is routing.
//
// Two extensions that both hold a BLOCKING webRequest listener both get the
// same request, and neither can see the other. If both answer `{cancel: true}`
// and open a replacement, the browser carries out both: one navigation becomes
// two tabs, same address, same container, every single time.
//
// That happened. commander routes `*.example.com` from managed storage; linkward
// held its own `docs.example.com` rule with interception on. Every bookmark
// and every launcher hit on those hosts opened twice, for weeks, and NOTHING in
// either extension could say so — each one was working perfectly, on its own
// evidence. commander's badge reports the two ways it can be switched OFF; it
// had no way to report being switched on TWICE.
//
// The platform gives no listener census: an extension cannot enumerate other
// extensions' webRequest listeners. So this is asked, over the claim protocol,
// and answered honestly by each participant — see docs/protocol.md.
//
// That leaves everything which does not answer, and Multi-Account Containers is
// the example that cost a day: a blocking listener, a list of site assignments,
// no protocol, and therefore invisible to every check either side could run.
// `management` can see it, and this file used to say that permission's warning
// was worse than the bug. As a REQUIRED permission it still would be. Optional
// and asked for from this add-on's own page it is the only answer there is, so
// silentRouters() reads what it returns — see lib/permissions.js.
//
// Pure. No browser APIs: the caller collects the answers and hands them over.

/**
 * What this extension says when a peer asks what it is doing.
 *
 * `routing` is the operative word and it means one thing: "a navigation I see
 * right now could be reopened by me". All three of these have to be true for
 * that, and each of them is a real state this extension gets into:
 *
 *   watching   the optional webRequest grant is held and the listener is on.
 *              Without the grant `chrome.webRequest` is absent, not empty.
 *   inert      no policy reached managed storage. It still answers claims, but
 *              it decides nothing.
 *   paused     the emergency stop, session-scoped.
 *
 * `dryRun` is deliberately NOT in that list. A dry run still logs what it would
 * have done and still competes for nothing — it cancels no request — so it is
 * reported separately rather than folded in, because "would clash once you
 * switch it on" is worth seeing before you switch it on.
 *
 * @param {{watching?: boolean, inert?: boolean, paused?: boolean, config?: object}} state
 */
export function routingState({ watching, inert, paused, config } = {}) {
  const armed = watching === true && inert !== true && paused !== true;
  const dryRun = config?.dryRun === true;
  return {
    routing: armed && !dryRun,
    dryRun: armed && dryRun,
    routes: armed ? routeHosts(config) : [],
  };
}

/**
 * The host patterns this policy would act on, for a human to compare against
 * another extension's list.
 *
 * Patterns, not hosts, and a regex rule is reported as its id rather than as
 * its source. This list is read by a person deciding which of two extensions to
 * switch off; a page of escaped alternations does not help them do that, and
 * shipping one to another extension's UI would be leaking policy detail for no
 * gain. The ids are already in the config repo under review.
 */
export function routeHosts(config) {
  const out = [];
  for (const rule of config?.rules ?? []) {
    const host = rule?.match?.host;
    if (typeof host === 'string' && host) out.push(host);
    else if (typeof rule?.match?.regex === 'string' && anchoredHost(rule.match.regex)) {
      out.push(anchoredHost(rule.match.regex));
    } else if (rule?.id) out.push(`rule:${rule.id}`);
  }
  // Deduplicated: two rules on one host with different paths are one host to
  // the person reading this.
  return [...new Set(out)];
}

/**
 * The host a regex rule is anchored to, if it is anchored to exactly one.
 *
 * A peer READS this list to decide whether to stand down, so an entry it cannot
 * match is an entry that does nothing. `rule:<id>` is a label: it names the rule
 * for a person comparing two settings pages, and it makes a peer keep asking
 * about a host this extension is routing — which is the pair, on precisely the
 * sign-in hand-offs a regex rule tends to be written for. Found by running the
 * real policy through both extensions: three of its twelve rules published as
 * ids, all three `scope: external`, all three anchored to one host.
 *
 * What is published is the HOST and never the pattern. The reason for the id in
 * the first place still holds — a page of escaped alternations helps nobody, and
 * shipping one into another extension's UI leaks policy detail for no gain — but
 * the host an external sign-in lands on is not the secret part of a policy.
 *
 * Conservative by construction. It reads `^`, a scheme, a run of literal host
 * characters, an optional port, and then a boundary that ends the host. It gives
 * up on anything that could widen or narrow what follows: an alternation, a
 * class, a quantifier, a group, a missing anchor, a missing boundary. A regex
 * matching two hosts must not be published as one of them, because a peer would
 * stand down on the one and keep doubling the other.
 *
 * One widening is accepted and is worth stating. A peer matches a published host
 * the way this extension does — the host and every subdomain of it — while a
 * regex pinned to `a.example.com` covers only that name. So a peer may stand
 * down on `x.a.example.com` where no rule here would have fired. What follows is
 * not "nobody decides": this extension still sees that request and still runs
 * the whole ladder over it, having only no specific rule. The alternative is the
 * pair, live, on the sign-in hand-offs regex rules get written for — and two
 * tabs through a sign-in is two sessions, which is the disease this extension
 * exists to cure rather than a nuisance.
 *
 * @param {string} regex  the rule's `match.regex`
 * @returns {string} the host, or '' when it is not a single anchored one
 */
function anchoredHost(regex) {
  // `^`, the scheme, a run of literal host characters, an optional port, and
  // then a boundary that ENDS the host: a path separator or the end of the
  // pattern. The boundary is the whole point. `^https://a\\.example\\.com` with
  // nothing after it is a prefix match, so it also matches
  // `a.example.com.evil.test` — publishing it as a host would hand a peer a
  // name that is not the set of things this rule routes.
  //
  // The authority itself may hold only literals and escaped dots. Anything that
  // could widen or narrow it — an alternation, a class, a quantifier, a group —
  // means the rule covers more than one host, and publishing one of them would
  // have the peer stand down on that one and carry on doubling the rest.
  //
  // The prefix is read, but the WHOLE pattern has to be checked: an alternation
  // at the top level splits the entire expression, so
  // `^https://a\\.example\\.com/|^https://b\\.other\\.com/` starts with a host
  // this reads cleanly and routes a second one it never sees.
  if (hasBareAlternation(regex)) return '';
  const m = /^\^https(?:\?)?:\/\/((?:[A-Za-z0-9-]|\\\.)+)(?::\d+)?(?:\/|\$)/.exec(regex);
  return m ? m[1].replace(/\\\./g, '.').toLowerCase() : '';
}

/**
 * Is there a `|` that splits the whole pattern rather than part of one?
 *
 * Depth matters and position does not. `(foo|bar)` chooses between two paths
 * under one host and is safe at any offset; a bare `|` chooses between two whole
 * expressions wherever it sits, including after the host has been read. So this
 * counts groups and skips character classes, and answers only about depth zero.
 *
 * An escape consumes the next character whatever it is, which is what keeps a
 * literal `\|` in a path from being mistaken for the operator.
 */
function hasBareAlternation(regex) {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < regex.length; i++) {
    const ch = regex[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) return true;
  }
  return false;
}

/**
 * Installed add-ons that can route a container and will never answer a ping.
 *
 * By CAPABILITY, never by name. A list of known ids goes stale the first time
 * somebody installs the next container add-on, and it would have to be shipped
 * and released to learn one — so this reads what each add-on declares it can
 * do, which is the thing that actually matters:
 *
 *   contextualIdentities   it can read and create containers. On its own that
 *   + cookies              is not enough to put a tab in one: `tabs.create`
 *                          refuses a `cookieStoreId` without `cookies`, so an
 *                          add-on holding only the first can list containers
 *                          and never open a tab in one.
 *   webRequest             it can take a request away from the tab it was
 *   + webRequestBlocking   heading for, which is what makes two of them open
 *                          two tabs. Both, because `webRequestBlocking` only
 *                          adds blocking to an API that `webRequest` opens, and
 *                          only with `<all_urls>` or a host pattern: a blocking
 *                          listener with no host to run on cannot act.
 *
 * `cookies` alone is NOT counted, and that was raised in review as a gap. It is
 * true that `tabs.create` needs only `cookies` to name a container, so a
 * cookies-only add-on can technically put a tab in one. It is also declared by
 * password managers, privacy tools and anything that reads a session — this
 * profile has several — so counting it would fill the list with add-ons that
 * route nothing. The list is read by somebody deciding which add-on to switch
 * off, and a list containing their password manager is the warning they learn
 * to click past. Under-reporting a container add-on that holds no
 * `contextualIdentities` is the cheaper mistake: it cannot see the containers
 * it would have to name.
 *
 * `enabled` is required. A disabled add-on routes nothing and naming it would
 * be the warning that cries wolf — the one people learn to click past, so that
 * the time it is real it gets clicked past too.
 *
 * `answeredIds` is what the census heard back from, and it is deliberately NOT
 * the configured peer list. A peer that is installed and silent — uninstalled
 * background, a broken build, a listener that never registered — is precisely
 * the case this function exists to catch, and excluding it by id would hide the
 * one peer whose own report cannot be trusted. A peer that did answer is left
 * out, because it is already in the census by name with what it is actually
 * doing, and listing it twice would say a protocol that works is a problem.
 *
 * @param {Array<object>} infos     management.getAll() results
 * @param {{selfId?: string, answeredIds?: string[]}} who
 * @returns {Array<{id, name, version, why: string[]}>} by name
 */
export function silentRouters(infos = [], { selfId, answeredIds = [] } = {}) {
  const known = new Set([selfId, ...answeredIds].filter(Boolean));
  const found = [];
  for (const a of Array.isArray(infos) ? infos : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type !== 'extension' || a.enabled !== true) continue;
    if (typeof a.id !== 'string' || !a.id || known.has(a.id)) continue;
    const perms = Array.isArray(a.permissions) ? a.permissions : [];
    const hosts = Array.isArray(a.hostPermissions) ? a.hostPermissions : [];
    const why = [];
    if (perms.includes('contextualIdentities') && perms.includes('cookies')) {
      why.push('opens tabs in containers');
    }
    // A blocking listener is only a router where it has somewhere to run. An
    // add-on whose only host pattern is its own moz-extension:// origin cannot
    // see a navigation — measured on a real profile, where exactly that add-on
    // would otherwise have been reported as a second router.
    if (
      perms.includes('webRequest') &&
      perms.includes('webRequestBlocking') &&
      hosts.some(onTheWeb)
    ) {
      why.push('can take a request before it is sent');
    }
    if (!why.length) continue;
    found.push({
      id: a.id,
      name: displayable(a.name) || displayable(a.id) || 'another extension',
      version: displayable(a.version),
      why,
    });
  }
  return found.sort((x, y) => x.name.localeCompare(y.name));
}

/** Does this host pattern reach an ordinary web page? */
function onTheWeb(pattern) {
  return typeof pattern === 'string' && /^(<all_urls>|\*:|https?:)/.test(pattern);
}

/**
 * Peers that are also routing.
 *
 * Only ever a clash when BOTH sides are live. One router is the working state,
 * whichever one it is — this must not nag about a peer being installed, or it
 * becomes the warning everybody clicks past, and the one time it is real it
 * gets clicked past too.
 *
 * A peer that answers `defersTo` naming THIS extension is marked rather than
 * dropped. It is still holding the same requests, and it releases only the hosts
 * published here — a host this policy acts on without a rule, from a bookmark
 * folder hint, is on no published list and can still open twice. So it stays in
 * the census and stops being an alarm, which is the honest middle: the thing
 * that was wrong has been handled, and the part that has not been is small and
 * worth a sentence.
 *
 * `self.id` is required for that and deliberately not defaulted. Without it no
 * peer can be confirmed to be giving way to THIS extension rather than to some
 * third one, and guessing would quiet a warning that is still entirely true.
 *
 * @param {{routing?: boolean, id?: string}} self  this extension's own routingState()
 * @param {Array<object|null>} answers       one cc:ping reply per peer, nulls allowed
 * @returns {Array<{id, name, version, routes, overlap, standingDown}>} loudest first
 */
export function clashes(self, answers = []) {
  if (self?.routing !== true) return [];
  const found = [];
  for (const a of answers) {
    if (!a || typeof a !== 'object') continue;
    if (a.routing !== true) continue;
    const routes = (Array.isArray(a.routes) ? a.routes : []).filter(
      (r) => typeof r === 'string' && r,
    );
    found.push({
      id: typeof a.id === 'string' ? a.id : '',
      // Both halves of the fallback are filtered, not only the first. A peer that
      // answers `name: ''` would otherwise be reported as nothing at all, and one
      // whose id is not a string would be reported as whatever String() makes of
      // it. The sentence this ends up in has to name something a person can go
      // and find.
      name: displayable(a.name) || displayable(a.id) || 'another extension',
      version: typeof a.version === 'string' ? a.version : '',
      routes,
      overlap: overlapping(self.routes ?? [], routes),
      // Claimed AND consistent with what the same reply publishes. A peer that
      // says it is giving way while still listing hosts this policy routes is
      // contradicting itself in one message, and the overlap is the half backed
      // by evidence: those are the hosts both would act on. Believe that half.
      standingDown:
        typeof self.id === 'string' &&
        self.id !== '' &&
        Array.isArray(a.defersTo) &&
        a.defersTo.includes(self.id) &&
        overlapping(self.routes ?? [], routes).length === 0,
    });
  }
  // A peer still fighting outranks one that has given way, whatever either of
  // them overlaps on; below that, the most shared hosts is the most damage. The
  // first entry is the one whose name goes in the one-line warning, so this
  // ordering is what decides whether that line is an alarm or a statement.
  return found.sort(
    (a, b) =>
      Number(a.standingDown) - Number(b.standingDown) || b.overlap.length - a.overlap.length,
  );
}

/** A field from a peer, if it is a string with something in it. Otherwise ''. */
function displayable(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The hosts a `never` list would have to name for this extension to stand down.
 *
 * The durable half of the fix the popup offers. Pausing is session-scoped on
 * purpose, so the lasting version is an edit to the managed policy, and this is
 * the list that edit needs. `never` is checked before the rules and it also
 * discards bookmark-folder hints, so a host named here really does take this
 * extension out of the pair rather than merely out of the rule that matched.
 *
 * Three things happen to the peers' answers on the way:
 *
 *   - The OVERLAP wins where there is one, because those are the hosts both
 *     add-ons act on and therefore the tabs actually arriving in pairs. Where a
 *     peer overlaps on nothing, its whole route list is offered instead: it is
 *     holding the same requests, and no shared host only means neither has
 *     published one.
 *   - `rule:<id>` entries are dropped. A regex rule is published as its id
 *     rather than its source, so it is a label and not a host, and pasting it
 *     into `never` would produce a policy that fails validation.
 *   - A leading `*.` comes off. This policy language has no globs: `never`
 *     matches a host and every subdomain of it, so `example.com` is what
 *     `*.example.com` means here, and leaving the star on would silently match
 *     nothing at all.
 *
 * Sorted, because this is copied into a file somebody reviews in a diff.
 *
 * @param {Array<{overlap?: string[], routes?: string[]}>} found  clashes()
 * @returns {string[]}
 */
export function standDownHosts(found = []) {
  const out = new Set();
  for (const peer of found) {
    const from = peer?.overlap?.length ? peer.overlap : (peer?.routes ?? []);
    for (const entry of from) {
      if (typeof entry !== 'string') continue;
      const host = entry.trim().replace(/^\*\./, '').toLowerCase();
      if (!host || host.startsWith('rule:')) continue;
      out.add(host);
    }
  }
  return [...out].sort();
}

/**
 * The patterns two lists agree on.
 *
 * Not set intersection: `*.example.com` and `docs.example.com` are the same
 * jurisdiction written at two widths, and that pair IS the bug this file was
 * written for. Reported under the more specific of the two, because that is the
 * one somebody can search their own settings for.
 */
export function overlapping(mine, theirs) {
  const out = new Set();
  for (const m of mine) {
    for (const t of theirs) {
      if (m === t) out.add(t);
      else if (covers(m, t)) out.add(t);
      else if (covers(t, m)) out.add(m);
    }
  }
  return [...out];
}

/** Does the glob `pattern` cover the literal-or-glob `host`? */
function covers(pattern, host) {
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1); // '.example.com'
  // The bare apex too: `*.example.com` in this policy language includes `example.com`.
  return host.endsWith(suffix) || host === pattern.slice(2);
}

/**
 * The warning, in one sentence, or null.
 *
 * Built here rather than in each page's script so the toolbar panel and the
 * settings page cannot drift into saying different things about one fact.
 */
export function clashLine(found = []) {
  if (!found.length) return null;
  const first = found[0];
  const who = [first.name, first.version].filter(Boolean).join(' ');
  const rest = found.length > 1 ? ` (and ${found.length - 1} more)` : '';
  // Every one of them has given way. Telling somebody to go and switch an
  // add-on off at this point is asking for a fix that has already happened, and
  // a warning that survives its own remedy is one nobody reads the next time.
  if (found.every((p) => p.standingDown)) {
    return (
      `${who}${rest} is also routing navigation, and gives way on the hosts this policy` +
      ' publishes — those open once. A host reopened here without a rule, from a bookmark' +
      ' folder, is on no published list and can still open twice.'
    );
  }
  const where = first.overlap.length
    ? ` Both route ${first.overlap.slice(0, 3).join(', ')}${first.overlap.length > 3 ? ', …' : ''}.`
    : '';
  return (
    `${who}${rest} is also routing navigation.${where}` +
    ' Two extensions that both reopen a request open two tabs for it.' +
    ' Switch routing off in one of them.'
  );
}

/** Has every peer in the census given way to this extension? */
export function allStandingDown(found = []) {
  return found.length > 0 && found.every((p) => p?.standingDown === true);
}
