// The event page: arming, input assembly, and carrying out a Decision.
//
// Everything that DECIDES lives in lib/engine.js, which has no browser APIs in
// it. This file assembles one plain object, hands it over, and performs the
// verb it gets back. That split is what makes the ladder testable without a
// browser and the same engine runnable by the config repo's verifier.

import { decide, RUNG } from './lib/engine.js';
import { createClaims } from './lib/claims.js';
import { loadConfig } from './lib/config.js';
import { isCandidateTab } from './lib/candidates.js';
import { noteFocusChange, readFocusState, seedFocusState } from './lib/focus.js';

const PEERS = ['linkward@sapn95.github.io', 'beeline@sapn95.github.io'];
const CLAIM_TIMEOUT_MS = 200;

// tabId -> when it was flagged. A Map, not storage: this is per-session state,
// and an event-page restart should forget a stale tab rather than ask about it.
const candidates = new Map();
const spent = new Set();
const claims = createClaims({ allow: PEERS, ttlMs: 10_000 });

// The last N decisions, for the popup and for harvesting verifier fixtures from
// reality rather than guessing them. In memory only; it never leaves the
// browser and never reaches the public repo.
const log = [];
const LOG_MAX = 50;

let loaded = { config: null, inert: true, errors: [] };
let paused = false;

// --- Arming, synchronously, before any await -------------------------------
//
// The MV3 background is an event page: only listeners registered during the
// first synchronous run are ones the browser can restart the page FOR. One
// added after an await is invisible to that machinery, and the extension
// silently stops working the moment the page first idles out.

function onBeforeRequest(details) {
  return situationFor(details).then((input) => {
    if (!input) return {};
    const decision = decide(input);
    remember(decision, input, details);
    if (decision.action === 'reopen') {
      openThere(details.tabId, details.url, decision.cookieStoreId);
      // Cancelled rather than redirected: a redirect cannot move a tab into
      // another cookie store, so the page would load in the wrong one first.
      return { cancel: true };
    }
    if (decision.action === 'ask') {
      return { redirectUrl: pickerUrl(details.url, decision) };
    }
    return {};
  });
}

function armRequests() {
  try {
    if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) return;
    chrome.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
      ['blocking'],
    );
  } catch {
    // No permission yet. permissions.onAdded brings us back here.
  }
}

function onFocusChanged(windowId) {
  // Returned rather than dropped: the browser keeps an event page alive for a
  // promise a listener gives back, and this one has a write in it.
  return noteFocusChange(windowId);
}

function armFocus() {
  try {
    if (!chrome.windows.onFocusChanged.hasListener(onFocusChanged)) {
      chrome.windows.onFocusChanged.addListener(onFocusChanged);
    }
  } catch {
    // No windows to focus. The shape rule then never fires, and an entry that
    // cannot be classified is left alone.
  }
  seedFocusState().catch(() => {});
}

function arm() {
  armRequests();
  armFocus();
  refresh();
}

// Before anything else, and before any await.
arm();

chrome.tabs.onCreated.addListener((tab) => {
  if (claims.consume(tab, Date.now())) return;
  if (isCandidateTab(tab)) candidates.set(tab.id, Date.now());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  candidates.delete(tabId);
  spent.delete(tabId);
  // Firefox reuses tab ids, so a binding left behind would silently exempt
  // whichever stranger inherits the number.
  claims.forget(tabId);
});

chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);
chrome.permissions.onAdded.addListener(arm);

// The claim receiver is armed even in inert mode: a config this extension
// cannot read must never break the peers that depend on it.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const from = sender?.id;
  const now = Date.now();
  switch (msg?.type) {
    case 'cc:claim':
      claims.claim({ ...msg, sender: from }, now);
      sendResponse({ ok: true });
      return true;
    case 'cc:release':
      claims.release({ ...msg, sender: from });
      sendResponse({ ok: true });
      return true;
    case 'cc:opened':
      claims.bind({ ...msg, sender: from });
      sendResponse({ ok: true });
      return true;
    case 'cc:ping':
      sendResponse({
        name: 'container-commander',
        version: chrome.runtime.getManifest?.()?.version,
        revision: loaded.config?.revision ?? null,
      });
      return true;
    default:
      return undefined;
  }
});

chrome.action?.onClicked?.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {});
});

// --- Assembling one plain object -------------------------------------------

async function situationFor(details) {
  if (details.frameId !== undefined && details.frameId !== 0) return null;
  if (paused) return null;

  const tabId = details.tabId;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const focus = await readFocusState();

  return {
    request: {
      url: details.url,
      method: details.method ?? 'GET',
      originUrl: details.originUrl,
      documentUrl: details.documentUrl,
    },
    tab: {
      cookieStoreId: tab?.cookieStoreId,
      openerTabId: tab?.openerTabId,
      url: tab?.url,
      pendingUrl: tab?.pendingUrl,
    },
    candidate: { since: candidates.get(tabId), spent: spent.has(tabId) },
    claims: { boundToTab: claims.isOurs(tabId), pendingMatch: null },
    focus,
    bookmarkHits: await hintsFor(details.url),
    config: loaded.config,
    containers: await listContainers(),
    now: Date.now(),
  };
}

/** Answered once per tab, whichever way it went. */
function remember(decision, input, details) {
  if (decision.rung > RUNG.GATE) spent.add(details.tabId);
  log.unshift({ at: input.now, url: details.url, decision });
  log.length = Math.min(log.length, LOG_MAX);
}

async function listContainers() {
  try {
    const list = await globalThis.browser?.contextualIdentities?.query({});
    return (list ?? []).map((c) => ({ name: c.name, cookieStoreId: c.cookieStoreId }));
  } catch {
    return [];
  }
}

async function openThere(tabId, url, cookieStoreId) {
  // Announced BEFORE the tab exists, and awaited: linkward would otherwise see
  // a fresh, opener-less http tab and offer a picker for a tab this extension
  // had just deliberately placed.
  await tell('linkward@sapn95.github.io', { type: 'cc:claim', url, cookieStoreId });
  let created;
  try {
    created = await chrome.tabs.create({ url, active: true, cookieStoreId });
  } catch {
    await tell('linkward@sapn95.github.io', { type: 'cc:release', url });
    return;
  }
  if (typeof created?.id === 'number') {
    claims.bind({ tabId: created.id, sender: PEERS[0] });
    candidates.delete(created.id);
    await tell('linkward@sapn95.github.io', { type: 'cc:opened', tabId: created.id, url });
  }
  // Separate on purpose: the link is already open in the right container by
  // now, so a failure here must not undo that.
  if (typeof tabId === 'number' && tabId >= 0) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** A peer being absent is the normal case, so this never rejects. */
function tell(id, msg) {
  return Promise.race([
    chrome.runtime.sendMessage(id, msg).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), CLAIM_TIMEOUT_MS)),
  ]);
}

function pickerUrl(url, decision) {
  const target = new URL(chrome.runtime.getURL('pick/pick.html'));
  target.searchParams.set('url', url);
  if (decision.preselect) target.searchParams.set('preselect', decision.preselect);
  return target.toString();
}

// --- Bookmarks --------------------------------------------------------------

let indexPromise = null;

/**
 * Built behind a memoised promise and awaited inside the blocking handler.
 * Firefox suspends the request while a promise-returning blocking listener
 * resolves, so this costs latency and not correctness — whereas without it the
 * FIRST bookmark opened after an idle unload routes differently from the
 * second, which is the class of bug that cannot be reproduced on demand.
 */
function bookmarkIndex() {
  indexPromise ??= buildIndex().catch(() => new Map());
  return indexPromise;
}

/** Canonical, so a trailing slash or a fragment cannot make two of one URL. */
export function canonical(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.host.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return '';
  }
}

async function buildIndex() {
  const folders = loaded.config?.bookmarks?.folders ?? [];
  const index = new Map();
  if (!folders.length || !chrome.bookmarks) return index;
  const tree = await chrome.bookmarks.getTree();
  const walk = (node, path) => {
    const here = node.title ? `${path}/${node.title}` : path;
    const mapped = folders.find((f) => here.endsWith(f.path));
    for (const child of node.children ?? []) {
      if (child.url && mapped) {
        const key = canonical(child.url);
        const hits = index.get(key) ?? [];
        hits.push({ folderPath: mapped.path, container: mapped.container });
        index.set(key, hits);
      }
      if (child.children) walk(child, here);
    }
  };
  for (const root of tree) walk(root, '');
  return index;
}

async function hintsFor(url) {
  const index = await bookmarkIndex();
  return index.get(canonical(url)) ?? [];
}

// --- Config -----------------------------------------------------------------

async function refresh() {
  loaded = await loadConfig(chrome).catch(() => ({
    config: null,
    inert: true,
    errors: ['load failed'],
  }));
  indexPromise = null;
  badge();
}

function badge() {
  const text = loaded.inert ? '!' : '';
  chrome.action?.setBadgeText?.({ text }).catch?.(() => {});
}

// Read by the popup, which is the honest answer to managed storage not being
// live: it shows the loaded revision and its age rather than pretending.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:status') return undefined;
  sendResponse({ ...loaded, paused, log: log.slice(0, 20) });
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:pause') return undefined;
  // Session-scoped by design: an emergency stop that outlived the browser
  // would be a second, writable source of truth — the disease this extension
  // exists to cure.
  paused = msg.paused === true;
  sendResponse({ paused });
  return true;
});
