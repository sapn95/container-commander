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
    else if (rule?.id) out.push(`rule:${rule.id}`);
  }
  // Deduplicated: two rules on one host with different paths are one host to
  // the person reading this.
  return [...new Set(out)];
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
      name: typeof a.name === 'string' ? a.name : (a.id ?? 'another extension'),
      version: typeof a.version === 'string' ? a.version : '',
      routes,
      overlap: overlapping(self.routes ?? [], routes),
    });
  }
  // The one with the most shared hosts is the one doing the most damage, and it
  // is the one whose name belongs in a one-line warning.
  return found.sort((a, b) => b.overlap.length - a.overlap.length);
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
