// The toolbar button.
//
// The one thing this extension does that is not a decision: you looked at a
// tab, you decided the ladder got it wrong or never had an opinion, and you
// want it somewhere else. Rare by design — a routing add-on whose button you
// reach for daily has the wrong rules — but the gesture has to exist, because a
// policy that cannot be overruled by the person it serves is not a policy.
//
// The context menu has done this since 0.2.1. It is on a right-click, under a
// submenu, on a tab strip most people never right-click, which is another way
// of saying it did not exist. This is the same code path with a place to stand.
//
// It does NOT go through the ladder. decide() answers "where does this flow
// belong"; you have just answered that yourself, and asking the engine to
// confirm it would be the confirm-page dialog rebuilt out of our own parts.

import { hasWatchPermissions, requestWatchPermissions } from '../lib/permissions.js';

const $ = (id) => document.getElementById(id);

// Missing grant is a strip above the panel and never a state instead of it.
// Moving a tab by hand needs no host permission at all, and hiding the only
// control on the page behind a grant it does not need would be this extension's
// signature failure with a new coat on.
if (!(await hasWatchPermissions())) $('warn').hidden = false;

$('grant-button').addEventListener('click', async (event) => {
  // FIRST, before any await. A handler stops being user-initiated the moment it
  // awaits anything, and permissions.request then fails with no explanation.
  const granted = await requestWatchPermissions();
  if (granted) location.reload();
  else event.target.disabled = true;
});

$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch(() => {});
  window.close();
});

const tab = await current();
const url = tab?.url ?? '';

if (!/^https?:\/\//.test(url) || typeof tab?.id !== 'number') {
  $('nothing').hidden = false;
} else {
  const here = plain(tab.cookieStoreId);
  const containers = await listContainers();
  const mine = containers.find((c) => plain(c.cookieStoreId) === here);

  $('here-name').textContent = mine ? mine.name : 'No container';
  if (mine?.colour) $('here-dot').style.background = mine.colour;

  // The host and not the address. A popup is 260px wide and a wrapped query
  // string would push the buttons off the bottom of it — and the question this
  // panel asks is about an identity, which is a property of the site.
  $('host').textContent = hostOf(url);

  // Everywhere the tab is not, plus out. Offering the container it is already
  // in would cost the tab its history and its scroll position to arrive exactly
  // where it started.
  const targets = containers.filter((c) => plain(c.cookieStoreId) !== here);
  if (here) targets.push({ name: 'No container', cookieStoreId: '' });

  render(targets);
  $('move').hidden = false;
  document.addEventListener('keydown', onKey);
}

function render(targets) {
  const box = $('choices');
  box.replaceChildren();
  targets.forEach((c, i) => box.append(choice(c, i + 1)));
}

function choice(c, n) {
  const b = document.createElement('button');
  b.type = 'button';

  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = n <= 9 ? String(n) : '';

  const dot = document.createElement('span');
  dot.className = 'dot';
  if (c.colour) dot.style.background = c.colour;

  const name = document.createElement('span');
  name.textContent = c.name;

  b.append(key, dot, name);
  b.addEventListener('click', () => move(c.cookieStoreId));
  return b;
}

function onKey(e) {
  // ⌘, Ctrl and Alt belong to the browser, as in the picker.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > 9) return;
  const button = document.querySelectorAll('#choices button')[n - 1];
  if (button) {
    e.preventDefault();
    button.click();
  }
}

/**
 * Handed to the background rather than done here.
 *
 * openThere() announces the move to linkward before the tab exists and binds
 * the claim after — without that handshake linkward sees a fresh, opener-less
 * http tab and offers a picker for the answer you just gave. It also writes the
 * OVERRIDE line into the log, so the popup's list can account for every tab
 * that moved, including the ones no rule moved.
 */
async function move(cookieStoreId) {
  await chrome.runtime
    .sendMessage({
      type: 'cc:override',
      tabId: tab.id,
      url,
      from: tab.cookieStoreId ?? '',
      to: cookieStoreId,
    })
    .catch(() => {});
  // The tab this panel described is gone either way; a popup left hanging over
  // its replacement is pointing at nothing.
  window.close();
}

async function current() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t ?? null;
  } catch {
    return null;
  }
}

/**
 * The two spellings of "no container", reduced to one.
 *
 * A tab outside every container reports `firefox-default`; tabs.create wants
 * the key absent, so everything that builds one calls it the empty string. Both
 * are true and comparing across them is how "No container" ended up being
 * offered to a tab that was already in none — a reopen that costs a history and
 * a scroll position to arrive exactly where it started.
 */
function plain(cookieStoreId) {
  const s = cookieStoreId ?? '';
  return s === 'firefox-default' ? '' : s;
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

async function listContainers() {
  try {
    const list = await globalThis.browser?.contextualIdentities?.query({});
    return (list ?? []).map((c) => ({
      name: c.name,
      cookieStoreId: c.cookieStoreId,
      colour: c.colorCode,
    }));
  } catch {
    return [];
  }
}
