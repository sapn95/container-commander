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
// extensions' webRequest listeners, and `management` would need a permission
// whose warning is worse than the bug. So this is asked, over the claim
// protocol, and answered honestly by each participant — see docs/protocol.md.
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
 * Conservative by construction. It reads `^`, a scheme, then a run of literal
 * host characters, and gives up the moment it meets anything that could widen or
 * narrow what follows: an alternation, a class, a quantifier, a group. A regex
 * matching two hosts must not be published as one of them, because a peer would
 * then stand down on the one host and keep doubling on the other.
 *
 * @param {string} regex  the rule's `match.regex`
 * @returns {string} the host, or '' when it is not a single anchored one
 */
function anchoredHost(regex) {
  // `^https://` or `^https?://`, with the optional marker on the s only.
  const m = /^\^https(\?)?:\/\/([^/]*)/.exec(regex);
  if (!m) return '';
  // A port is not part of a host pattern, and a peer matches on host alone.
  const authority = m[2].replace(/:\d+$/, '');
  // Every character has to be a literal, or an escaped dot. Anything else —
  // ( ) [ ] { } | + * ? . $ — means the host is not the fixed thing it looks
  // like, and guessing which half of it to publish is how a rule that covers
  // two hosts silently stops covering one.
  if (!/^(?:[A-Za-z0-9-]|\\\.)+$/.test(authority)) return '';
  return authority.replace(/\\\./g, '.').toLowerCase();
}

/**
 * Peers that are also routing.
 *
 * Only ever a clash when BOTH sides are live. One router is the working state,
 * whichever one it is — this must not nag about a peer being installed, or it
 * becomes the warning everybody clicks past, and the one time it is real it
 * gets clicked past too.
 *
 * @param {{routing?: boolean}} self         this extension's own routingState()
 * @param {Array<object|null>} answers       one cc:ping reply per peer, nulls allowed
 * @returns {Array<{id, name, version, routes, overlap}>} worst overlap first
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
    });
  }
  // The one with the most shared hosts is the one doing the most damage, and it
  // is the one whose name belongs in a one-line warning.
  return found.sort((a, b) => b.overlap.length - a.overlap.length);
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
  const where = first.overlap.length
    ? ` Both route ${first.overlap.slice(0, 3).join(', ')}${first.overlap.length > 3 ? ', …' : ''}.`
    : '';
  return (
    `${who}${rest} is also routing navigation.${where}` +
    ' Two extensions that both reopen a request open two tabs for it.' +
    ' Switch routing off in one of them.'
  );
}
