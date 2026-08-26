// The picker.
//
// Defensive posture inherited from linkward's, and for the same reason: this
// page is web-accessible, so everything in the query string arrived from
// somewhere that is not us. Nothing here is ever rendered as HTML or as a
// link, and the only thing that opens a tab is a click on a button this file
// built itself.

const params = new URL(location.href).searchParams;
const target = params.get('url') ?? '';
const preselect = params.get('preselect') ?? '';

const $ = (id) => document.getElementById(id);

/** textContent, never innerHTML: the address came off a page somebody visited. */
$('url').textContent = target;

const containers = await listContainers();
render(containers);

document.addEventListener('keydown', onKey);

function render(list) {
  const box = $('choices');
  box.replaceChildren();
  list.forEach((c, i) => box.append(choice(c, i + 1)));
  box.append(choice({ name: 'No container', cookieStoreId: '' }, list.length + 1));
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

  if (c.name === preselect) b.className = 'preselect';
  b.append(key, dot, name);
  b.addEventListener('click', () => open(c.cookieStoreId));
  return b;
}

function onKey(e) {
  // ⌘, Ctrl and Alt belong to the browser. Taking ⌘C from somebody copying the
  // address off this page would be its own small betrayal.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeTab();
    return;
  }
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > 9) return;
  const button = document.querySelectorAll('#choices button')[n - 1];
  if (button) {
    e.preventDefault();
    button.click();
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

async function open(cookieStoreId) {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  // Announced before the tab exists, so the extension that asks about outside
  // links does not offer a second picker for the answer to this one.
  await chrome.runtime
    .sendMessage('linkward@sapn95.github.io', { type: 'cc:claim', url: target, cookieStoreId })
    .catch(() => {});
  // A14, the same rule the background applies to the override: the replacement
  // stands where the original stood. This page IS the original — it was reached
  // by redirecting the tab rather than by opening a new one — so its window and
  // its position are the ones to keep.
  //
  // Each field only if we have it. `undefined + 1` is NaN, tabs.create rejects
  // that as a type error, and the catch below turns the rejection into a picker
  // that swallows every choice you make on it.
  const place = {
    active: typeof tab?.active === 'boolean' ? tab.active : true,
    ...(Number.isInteger(tab?.windowId) ? { windowId: tab.windowId } : {}),
    ...(Number.isInteger(tab?.index) ? { index: tab.index + 1 } : {}),
  };
  const created = await chrome.tabs
    .create({ url: target, ...place, ...(cookieStoreId ? { cookieStoreId } : {}) })
    .catch(() => null);
  if (!created) return;
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id).catch(() => {});
}

async function closeTab() {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id).catch(() => {});
}
