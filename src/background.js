// The event page: arming, input assembly, and carrying out a Decision.
//
// Everything that DECIDES lives in lib/engine.js, which has no browser APIs in
// it. This file assembles one plain object, hands it over, and performs the
// verb it gets back. That split is what makes the ladder testable without a
// browser and the same engine runnable by the config repo's verifier.

import { decide, RUNG } from './lib/engine.js';
import { createClaims } from './lib/claims.js';
import { clashes, clashLine, routingState, allStandingDown } from './lib/census.js';
import { loadConfig } from './lib/config.js';
import { isCandidateTab } from './lib/candidates.js';
import { noteFocusChange, readFocusState, seedFocusState } from './lib/focus.js';

const PEERS = ['linkward@sapn95.github.io', 'beeline@sapn95.github.io'];
const CLAIM_TIMEOUT_MS = 200;
const CENSUS_TIMEOUT_MS = 2000;

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

/**
 * Whether onBeforeRequest is actually registered.
 *
 * Not a convenience flag. Without the optional grant `chrome.webRequest` is not
 * merely empty, it is ABSENT, so the line below throws and the catch swallows
 * it — and from the outside that is indistinguishable from an extension that is
 * watching and has had a quiet day. This is the one thing this file knows that
 * nothing else can find out, so it is recorded and reported rather than left as
 * the shape of a silence.
 */
let watching = false;

function armRequests() {
  try {
    if (!chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) {
      chrome.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
        ['blocking'],
      );
    }
    watching = true;
  } catch {
    // No permission yet. permissions.onAdded brings us back here.
    watching = false;
  }
  badge();
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

// --- The human override ----------------------------------------------------
//
// "Reopen this tab in ‹container›", on the tab's own context menu. Out of the
// ladder rather than a rung of it: no rule is read and no decision is made, so
// it is the one path by which a tab that already exists can be moved — and it
// exists precisely because the ladder refuses to do that on its own.
//
// `browser.menus`, NOT `chrome.menus`. The chrome namespace only ever exposed
// `contextMenus`, and the two names are separate permissions in Firefox: the
// manifest asks for `menus`, so `menus` is the namespace that goes with it. This
// was documented and requested for two releases before anything registered it,
// which is also how it became an unused-permission flag in store review.
const MENU_PARENT = 'cc:reopen';
const MENU_ITEM = 'cc:reopen:';
const menus = () => globalThis.browser?.menus;

async function buildMenu() {
  const api = menus();
  if (!api) return;
  await api.removeAll().catch(() => {});

  // Rebuilt wholesale on every container change rather than patched. The list is
  // never more than a handful of items and a patch that drifts from the real set
  // offers to move a tab into a container that no longer exists.
  const containers = await listContainers();
  api.create({
    id: MENU_PARENT,
    title: 'Reopen this tab in…',
    // The tab strip is where this belongs, and the page is where a hand reaches
    // for it. http(s) only: there is nothing to reopen about an about: page, and
    // a container is not a property it has.
    contexts: ['tab', 'page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  for (const c of containers) {
    api.create({ id: MENU_ITEM + c.cookieStoreId, parentId: MENU_PARENT, title: c.name });
  }
  // Last, and deliberately offered: moving a tab OUT of a container is the same
  // gesture, and without this the menu can only ever put things in.
  api.create({ id: MENU_ITEM, parentId: MENU_PARENT, title: 'No container' });
}

function onMenuClicked(info, tab) {
  const id = String(info?.menuItemId ?? '');
  if (!id.startsWith(MENU_ITEM)) return;
  return humanOverride({
    tabId: tab?.id,
    url: tab?.url ?? '',
    from: tab?.cookieStoreId ?? '',
    to: id.slice(MENU_ITEM.length),
  });
}

/** The two spellings of "no container" — `firefox-default` and absent — as one. */
const plain = (cookieStoreId) =>
  (cookieStoreId ?? '') === 'firefox-default' ? '' : (cookieStoreId ?? '');

/**
 * The one move this extension makes that is not a decision.
 *
 * Two things ask for it — the tab-strip menu and the toolbar button — and they
 * share this function rather than each doing the four steps, because the steps
 * are not obviously all of them. The peer handshake in openThere() is the one
 * that bites: skip it and linkward sees a fresh, opener-less http tab and
 * offers a picker for the answer somebody just gave by hand.
 *
 * @param {{tabId: number, url: string, from: string, to: string}} what
 */
// async only so the container names can be read before the line is written. It
// still answers with a promise, which is what the message handler awaits.
async function humanOverride({ tabId, url, from, to }) {
  if (!/^https?:\/\//.test(url) || typeof tabId !== 'number') return false;
  // Already there. Reopening would cost the tab its history and its scroll
  // position to arrive exactly where it started.
  //
  // Compared through plain() because a tab outside every container reports
  // `firefox-default` while tabs.create wants the key absent — so the menu's
  // "No container" and a tab that already has none are the same place spelled
  // two ways, and the raw comparison missed it.
  if (plain(from) === plain(to)) return false;

  // A reopen is a close and a re-fetch, so this cannot preserve a POST — which
  // is why the ladder never does it unasked. Here it was asked for.
  //
  // Done BEFORE it is logged, and the log now follows what happened rather than
  // what was asked for. tabs.create can refuse — a container deleted between
  // the menu being built and the click, most plainly — and the old order wrote
  // "moved to <container>" either way. In a list whose whole purpose is to say
  // where a tab went, that line is the one lie it cannot afford.
  const moved = await openThere(tabId, url, to);
  if (!moved) return false;

  // Logged like any other outcome, and named. The popup's list is the product,
  // and an override that happened invisibly would be the one decision it could
  // not account for. The rung is negative because this is beside the ladder and
  // not on it.
  const containers = await listContainers();
  log.unshift({
    at: Date.now(),
    url,
    decision: {
      action: 'reopen',
      rung: RUNG.OVERRIDE,
      reason: 'human-override',
      cookieStoreId: to,
    },
    from: containerName(containers, from),
    to: containerName(containers, to),
  });
  log.length = Math.min(log.length, LOG_MAX);
  return true;
}

function armMenu() {
  buildMenu().catch(() => {});
}

function arm() {
  armRequests();
  armFocus();
  armMenu();
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

// Registered here, at the top level, and not from inside buildMenu(). Only the
// listeners present on the first synchronous run are ones the browser can wake
// this page FOR, and a menu click on a slept-out event page would otherwise do
// nothing at all — the failure this file's opening comment is about.
menus()?.onClicked?.addListener(onMenuClicked);

// Containers are renamed and deleted by hand, and a menu built once goes stale
// offering somewhere that no longer exists.
for (const event of ['onCreated', 'onRemoved', 'onUpdated']) {
  globalThis.browser?.contextualIdentities?.[event]?.addListener(armMenu);
}

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
    // Answers what this extension is DOING, not merely that it is installed.
    // A peer needs that to warn its own user, and it has no other way to get
    // it: webRequest listeners are not enumerable across extensions.
    case 'cc:ping':
      sendResponse({
        id: chrome.runtime.id,
        name: 'container commander',
        version: chrome.runtime.getManifest?.()?.version,
        revision: loaded.config?.revision ?? null,
        ...routingState({ watching, inert: loaded.inert, paused, config: loaded.config }),
      });
      return true;
    default:
      return undefined;
  }
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

/**
 * The name of a container, for a log a person reads.
 *
 * `No container` rather than an empty cell: a tab outside every container is a
 * real answer and an empty cell reads as a value that failed to load.
 */
function containerName(containers, cookieStoreId) {
  const id = plain(cookieStoreId);
  if (!id) return 'No container';
  return (containers ?? []).find((c) => plain(c.cookieStoreId) === id)?.name ?? id;
}

/** Answered once per tab, whichever way it went. */
function remember(decision, input, details) {
  if (decision.rung > RUNG.GATE) spent.add(details.tabId);
  // Where the tab was, and where this decision left it.
  //
  // The log said what was DECIDED and never what happened, and the question
  // people arrive with is the other one: why is this tab not in the container I
  // expected. `leave` at rung 2 on a tab that already carries a container is a
  // correct decision and an invisible one — it is also the single most common
  // reason a sign-in lands in the wrong place, and reading it off `leave·2`
  // meant knowing the ladder by heart.
  const was = input.tab?.cookieStoreId;
  log.unshift({
    at: input.now,
    url: details.url,
    decision,
    from: containerName(input.containers, was),
    // A reopen lands in the rule's container; everything else leaves the tab
    // exactly where it already was.
    to: containerName(
      input.containers,
      decision.action === 'reopen' ? decision.cookieStoreId : was,
    ),
  });
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
  // A14: the replacement stands where the original stood.
  //
  // docs/architecture.md promised this from 0.1.0 and nothing implemented it —
  // `active: true` was hardcoded and neither of the other two was passed, so
  // every reopen jumped to the front of the window and the end of the strip.
  // index, windowId and active are not gated properties, so reading them back
  // needs no permission this extension does not already hold.
  //
  // Each field is carried over only if the browser gave us one. A tab that has
  // already gone answers without an index, and `undefined + 1` is NaN, which
  // tabs.create rejects as a type error, which the catch below swallows — so
  // the symptom of getting this wrong is that NOTHING is routed, anywhere,
  // silently. The first draft of this did exactly that, and the suite stayed
  // green because the fake tabs.create shrugged at NaN where Firefox does not.
  const from = typeof tabId === 'number' ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const place = {
    active: typeof from?.active === 'boolean' ? from.active : true,
    ...(Number.isInteger(from?.windowId) ? { windowId: from.windowId } : {}),
    ...(Number.isInteger(from?.index) ? { index: from.index + 1 } : {}),
  };

  // Announced BEFORE the tab exists, and awaited: linkward would otherwise see
  // a fresh, opener-less http tab and offer a picker for a tab this extension
  // had just deliberately placed.
  await tell('linkward@sapn95.github.io', { type: 'cc:claim', url, cookieStoreId });
  let created;
  try {
    // Spread rather than passed: "No container" arrives here as an empty string,
    // and the schema validator wants the key absent rather than falsy.
    created = await chrome.tabs.create({
      url,
      ...place,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    });
  } catch {
    await tell('linkward@sapn95.github.io', { type: 'cc:release', url });
    // Answered, not swallowed. The caller writes the line that says where the
    // tab went, and a reopen that never happened must not be logged as one.
    return false;
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
  return true;
}

/** A peer being absent is the normal case, so this never rejects. */
function tell(id, msg, timeoutMs = CLAIM_TIMEOUT_MS) {
  return Promise.race([
    chrome.runtime.sendMessage(id, msg).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
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
  // Not awaited: the config is loaded and this extension is ready to decide.
  // Whether somebody ELSE is also deciding is worth knowing without anybody
  // opening a page, and worth nothing if it delays arming.
  takeCensus().catch(() => {});
}

// --- Who else is routing ----------------------------------------------------
//
// Cached rather than polled. Probing on every badge() would put two cross-
// extension round trips in front of every decision, and the answer only changes
// when somebody installs or configures an extension — which is when a settings
// page is open, which is when it gets re-asked.
let clash = [];
// Two censuses can be in the air at once: both pages take one when they open,
// and a config change takes one of its own. They wait on other extensions, so
// they can finish in either order, and without this the slower one writes last
// and the badge ends up reporting a state that has already been superseded.
let censusRun = 0;

async function takeCensus() {
  const run = ++censusRun;
  // The id goes in because clashes() needs it: a peer says which extensions it
  // is giving way to, and without knowing its own id this one cannot tell being
  // given way to from watching somebody give way to a third add-on.
  const self = {
    id: chrome.runtime.id,
    ...routingState({ watching, inert: loaded.inert, paused, config: loaded.config }),
  };
  // A longer grace than a claim gets. A claim is racing a request this extension
  // is holding open, so 200 ms is a budget; nothing is waiting on this, and a
  // peer's event page may be asleep and need waking. Too short here does not
  // slow anything down — it just reports "no clash" about a live clash.
  const answers = await Promise.all(
    PEERS.map((id) => tell(id, { type: 'cc:ping' }, CENSUS_TIMEOUT_MS)),
  );
  const found = clashes(self, answers);
  // A superseded run still answers the page that asked it — that page is owed
  // what it measured — but it does not touch the cached state behind the badge.
  if (run === censusRun) {
    clash = found;
    badge();
  }
  return { self, clash: found, line: clashLine(found) };
}

/**
 * Three states worth a `!`, and each one was invisible in its turn.
 *
 * `inert` — no policy — already put a `!` on the icon at 0.1.0. The second was
 * worse and silent until 0.5.1: a policy loaded, no permission to watch,
 * nothing decided, and an icon with nothing on it. The state that looks
 * healthiest is the one where the extension is structurally unable to do
 * anything at all, which is the failure this whole repository is arranged
 * around, sitting in its own toolbar.
 *
 * The third is the mirror image and it ran for weeks: another extension routing
 * the same hosts, so every navigation to them opened TWICE. Both extensions
 * were healthy on their own evidence, and neither had a way to see the other —
 * webRequest listeners are not enumerable across extensions. See lib/census.js.
 */
function badge() {
  // A clash counts only while this extension is actually taking requests. Paused
  // it takes none, so nothing opens twice, and a `!` for a doubling that is not
  // happening is how people learn to ignore a badge. The answer is kept, not
  // discarded: resuming brings the mark straight back without asking again.
  // A peer that has given way is not a doubling. It says so in its own ping
  // reply, it releases the hosts this policy publishes, and marking the toolbar
  // for it would be a `!` about a pair that is no longer happening — which is
  // exactly how a badge stops being read.
  //
  // Left inside the short circuit rather than computed above it. badge() runs
  // during module evaluation, before `clash` is initialised, and the `!watching`
  // arm is what keeps it from being read there at all.
  const problem =
    !watching || loaded.inert || (!paused && clash.length > 0 && !allStandingDown(clash));
  chrome.action?.setBadgeText?.({ text: problem ? '!' : '' }).catch?.(() => {});
  // Red rather than the default grey. A badge you have to squint at to classify
  // is a badge that gets classified as decoration.
  chrome.action?.setBadgeBackgroundColor?.({ color: '#c0392b' }).catch?.(() => {});
  chrome.action?.setTitle?.({ title: title() }).catch?.(() => {});
}

/** Said in full: two problems at once must not hide one of them. */
function title() {
  const wrong = [];
  if (!watching) wrong.push('not watching navigation');
  if (loaded.inert) wrong.push('no policy installed');
  if (wrong.length) {
    return `container commander — ${wrong.join(', ')}. Nothing is being decided. Click to fix.`;
  }
  // Separate sentence, not a third item in that list: the two above mean
  // nothing happens, this one means everything happens twice. Reading them as
  // one list would put opposite failures behind the same wording.
  // The tooltip follows the badge: a state that does not earn a mark does not
  // earn a sentence on hover either. The arrangement is still on both settings
  // pages for anybody who goes looking.
  const line = paused || allStandingDown(clash) ? null : clashLine(clash);
  if (line) return `container commander — ${line}`;
  return 'container commander — move this tab';
}

// Read by the popup, which is the honest answer to managed storage not being
// live: it shows the loaded revision and its age rather than pretending.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:status') return undefined;
  sendResponse({ ...loaded, paused, log: log.slice(0, 20) });
  return true;
});

// Asked by both pages when they open, because that is when somebody is looking.
// Separate from cc:status, which answers synchronously off local state; this one
// waits on two other extensions and must not hold the rest of the page up.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:peers') return undefined;
  takeCensus().then(
    (result) => sendResponse(result),
    () => sendResponse({ clash: [], line: null }),
  );
  return true;
});

// The toolbar panel's one action. It could call tabs.create itself — the picker
// does — but then the peer handshake and the OVERRIDE log line would exist in
// two places, and the second copy is the one that goes stale.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:override') return undefined;
  humanOverride(msg).then(
    (moved) => sendResponse({ moved }),
    () => sendResponse({ moved: false }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cc:pause') return undefined;
  // Session-scoped by design: an emergency stop that outlived the browser
  // would be a second, writable source of truth — the disease this extension
  // exists to cure.
  paused = msg.paused === true;
  // Redrawn, not re-asked. Pausing changes nothing about what the other
  // extensions are doing, only whether their doing it can produce a second tab
  // here, so the cached census stays and the icon catches up with it.
  badge();
  sendResponse({ paused });
  return true;
});
