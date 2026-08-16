// The claim registry — the only way provenance crosses an extension boundary.
//
// No extension can see which extension opened a tab. That is the platform
// boundary, not an oversight to route around, so a claim is not a convenience:
// it is the mechanism. Every shape below was learned the hard way in linkward's
// own claim map, and is inherited here rather than rediscovered.
//
// Protocol: docs/protocol.md. Rung 1 of the ladder: docs/architecture.md.

/**
 * @param {{allow: string[], ttlMs: number}} options
 */
export function createClaims({ allow = [], ttlMs = 10_000 } = {}) {
  // url -> FIFO queue of {cookieStoreId, sender, at}.
  //
  // COUNTED and URL-KEYED, both deliberately. A single-slot claim breaks the
  // moment two launches overlap: the first to finish cancels the second, and
  // while either is in flight any new tab is taken for ours — including a link
  // somebody just clicked in another application.
  const pending = new Map();
  // Tab ids a peer owns. Consulted for the whole life of the tab, not just its
  // first request.
  const ours = new Set();

  const trusted = (sender) => typeof sender === 'string' && allow.includes(sender);

  function claim(msg, now = Date.now()) {
    // Malformed input arrives from another extension's message handler, so it
    // is filtered rather than trusted. A stranger is ignored silently: other
    // extensions are allowed to exist, and shouting about them is noise.
    if (!msg || typeof msg !== 'object') return false;
    const { url, cookieStoreId, sender } = msg;
    if (typeof url !== 'string' || !url) return false;
    if (typeof cookieStoreId !== 'string') return false;
    if (!trusted(sender)) return false;

    const queue = pending.get(url) ?? [];
    queue.push({ cookieStoreId, sender, at: now });
    pending.set(url, queue);
    return true;
  }

  function release(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const { url, sender } = msg;
    if (typeof url !== 'string' || !trusted(sender)) return false;
    const queue = pending.get(url);
    if (!queue?.length) return false;
    // Drops ONE, not the lot: two launches of the same address are two claims,
    // and one failing to create says nothing about the other.
    queue.shift();
    if (!queue.length) pending.delete(url);
    return true;
  }

  /**
   * Was this tab opened by a peer? Consumes the claim if so.
   *
   * Matched against BOTH url and pendingUrl, because which of the two carries
   * the address a tab was created with differs between browsers and between
   * versions of one browser.
   */
  function consume(tab, now = Date.now()) {
    for (const url of [tab?.url, tab?.pendingUrl]) {
      if (!url) continue;
      const queue = pending.get(url);
      if (!queue?.length) continue;
      const entry = queue.shift();
      if (!queue.length) pending.delete(url);
      // TTL is evaluated lazily, here, rather than by a timer: a timer in an
      // event page is a promise the platform does not keep. An expired claim is
      // consumed and discarded — never turned into a question, because expiry
      // means "we do not know", and unknown is leave-alone.
      if (now - entry.at > ttlMs) return null;
      if (typeof tab?.id === 'number') ours.add(tab.id);
      return entry;
    }
    return null;
  }

  function bind(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (!trusted(msg.sender) || typeof msg.tabId !== 'number') return false;
    ours.add(msg.tabId);
    return true;
  }

  const isOurs = (tabId) => ours.has(tabId);

  /**
   * Firefox reuses tab ids. A binding left behind when a tab closes would
   * silently exempt whichever stranger inherits the number.
   */
  const forget = (tabId) => ours.delete(tabId);

  return { claim, release, consume, bind, isOurs, forget };
}
