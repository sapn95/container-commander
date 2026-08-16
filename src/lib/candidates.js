// Entry detection, vendored VERBATIM from linkward.
//
// Not imported, not re-implemented: copied, because the two extensions must
// agree byte for byte about what an entry is. A re-implementation is the
// verifier-drift problem in miniature — two pieces of code that stay identical
// by care alone, until one evening they do not.
//
// Upstream: https://github.com/sapn95/linkward/blob/main/src/lib/candidates.js

/** Only ordinary web pages. A file:// or moz-extension:// page is not ours. */
export function isInterceptable(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Is this tab a candidate at the moment it is created?
 *
 * @param {object} tab - a browser Tab
 * @param {boolean} openedByUs - linkward opened it, so it must not re-ask
 */
export function isCandidateTab(tab, { openedByUs = false } = {}) {
  if (openedByUs) return false;
  // An opener means a page or a script in this browser opened it: a target
  // _blank link, a window.open, a middle click. Not external.
  if (tab?.openerTabId !== undefined && tab?.openerTabId !== null) return false;

  // A tab that was HANDED a link starts on that link — an http(s) address.
  // Anything else with a name is one of the browser's own pages: a new tab, a
  // start page, a session-restore placeholder. The user is about to type in it,
  // and what they type is not an external link.
  //
  // This used to be a list of four names — about:blank, about:newtab,
  // about:home, chrome://newtab/ — which is the wrong way round. Every browser
  // has its own, Vivaldi's start page is not among them, and the consequence
  // was linkward interrupting a search typed into the address bar of a fresh
  // tab. Asking about something the user typed themselves is the failure that
  // gets an add-on uninstalled.
  //
  // An EMPTY url stays a candidate: it means the browser has not said yet, not
  // that there is nothing.
  const url = tab?.pendingUrl || tab?.url || '';
  if (url && !isInterceptable(url)) return false;
  return true;
}
