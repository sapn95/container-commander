// A decision input, built from named overrides.
//
// The engine takes ONE plain object and no browser APIs, and the clock is
// injected — which is what turns every race in the failure catalogue into an
// ordinary table-driven test case rather than a timing experiment.
//
// The defaults describe the situation the extension actually cares about: a
// fresh tab, handed an ordinary address from outside, nothing claimed, nothing
// inherited. Every test then says only what makes ITS case different, so the
// case is readable as the one sentence it is testing.

export const WORK = 'firefox-container-2';
export const ADMIN = 'firefox-container-4';
export const PERSONAL = 'firefox-container-1';
export const DEFAULT_STORE = 'firefox-default';

export const CONTAINERS = [
  { name: 'personal', cookieStoreId: PERSONAL },
  { name: 'work', cookieStoreId: WORK },
  { name: 'admin', cookieStoreId: ADMIN },
];

export const NOW = 1_000_000;
export const GRACE = 1500;

/** A compiled config: already validated and already ordered by the compiler. */
export function config(over = {}) {
  return {
    schema: 1,
    revision: 'test-0000000',
    dryRun: false,
    focusGraceMs: GRACE,
    internalMarginMs: GRACE,
    claimTtlMs: 10_000,
    freshMs: 5000,
    authHosts: [],
    never: [],
    rules: [],
    bookmarks: { folders: [], onConflict: 'leave' },
    peers: [],
    ...over,
  };
}

/** One compiled rule. `scope` is mandatory in the real schema; so it is here. */
export function rule(over = {}) {
  return { id: 'r1', scope: 'external', match: { host: 'example.com' }, to: 'work', ...over };
}

export function situation(over = {}) {
  const { request, tab, candidate, claims, focus, ...rest } = over;
  return {
    request: {
      url: 'https://example.com/doc',
      method: 'GET',
      originUrl: undefined,
      documentUrl: undefined,
      ...request,
    },
    tab: {
      cookieStoreId: DEFAULT_STORE,
      openerTabId: undefined,
      url: '',
      pendingUrl: '',
      ...tab,
    },
    // The tab was created 200ms ago and has not been decided about yet.
    candidate: { since: NOW - 200, spent: false, ...candidate },
    claims: { boundToTab: false, pendingMatch: null, ...claims },
    // The browser came to the front as the tab appeared: an outside hand-off.
    focus: { focusedSince: NOW - 200, ...focus },
    bookmarkHits: [],
    config: config(),
    containers: CONTAINERS,
    now: NOW,
    ...rest,
  };
}

/** The browser has been in front long enough that this is plainly internal. */
export function insideBrowser(over = {}) {
  return situation({ focus: { focusedSince: NOW - 60_000 }, ...over });
}
