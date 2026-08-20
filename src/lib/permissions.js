// The permissions the interception needs, and the two questions the popup asks
// about them.
//
// They are OPTIONAL in the manifest on purpose: `<all_urls>` reads as "Access
// your data for all websites", and an add-on that demands that at install, to
// do nothing until you also hand it a policy, is one nobody installs. So it is
// asked for later, from the add-on's own page, by somebody who has decided they
// want it.
//
// The cost of that choice is the failure this file exists to end: until the
// grant happens, webRequest.onBeforeRequest cannot be registered at all, the
// extension sees no navigation, and it decides precisely nothing — while
// looking exactly like an extension that is working and has had a quiet day.

/** Asked for TOGETHER, and this is not a tidiness preference.
 *
 * permissions.request must run inside a user gesture, and a handler stops being
 * user-initiated the moment it awaits anything — so a second request, made
 * after the first resolves, always fails. One call or none.
 *
 * webRequest and webRequestBlocking are on Firefox's silently-granted list;
 * `<all_urls>` is the only one that actually prompts. */
export function watchPermissions() {
  return { origins: ['<all_urls>'], permissions: ['webRequest', 'webRequestBlocking'] };
}

const api = (given) => given ?? globalThis.chrome?.permissions;

/** False on any doubt: a wrong "yes" hides the very state this reports. */
export async function hasWatchPermissions(given) {
  const p = api(given);
  if (!p?.contains) return false;
  try {
    return await p.contains(watchPermissions());
  } catch {
    return false;
  }
}

/** Must be the FIRST thing in a click handler. See watchPermissions(). */
export function requestWatchPermissions(given) {
  const p = api(given);
  if (!p?.request) return Promise.resolve(false);
  return p.request(watchPermissions()).catch(() => false);
}
