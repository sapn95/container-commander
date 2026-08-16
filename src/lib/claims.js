// The claim registry. NOT IMPLEMENTED YET — on purpose.
//
// Contract (docs/protocol.md):
//   createClaims({ allow, ttlMs }) -> {
//     claim({url, cookieStoreId, sender}, now),
//     release({url, sender}, now),
//     consume(tab, now) -> {cookieStoreId, sender} | null,
//     bind({tabId, url, sender}, now),
//     isOurs(tabId) -> boolean,
//     forget(tabId),
//   }
//
// Counted and URL-keyed, FIFO per URL, TTL evaluated lazily at consume time.
// Every one of those words is a bug linkward already had.

// eslint-disable-next-line no-unused-vars
export function createClaims(options) {
  throw new Error('claims.createClaims: not implemented — see docs/protocol.md');
}
