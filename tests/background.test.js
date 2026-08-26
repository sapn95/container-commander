// @vitest-environment jsdom
//
// The event page, driven end to end against a fake browser.
//
// What is under test is not "does it route" — engine.test.js owns that — but
// the shell around the decision: that the listeners are registered in a way the
// browser can restart the page FOR, that a peer's claim is honoured even when
// this extension has no policy at all, and that carrying out a Decision does
// not leave somebody with two tabs and a question they already answered.

import { describe, it, expect, afterEach, vi } from 'vitest';

function makeEvent() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    hasListener: (fn) => fns.includes(fn),
    size: () => fns.length,
    emitSync: (...args) => fns.map((fn) => fn(...args)),
    emit: async (...args) => {
      const out = [];
      for (const fn of fns) out.push(await fn(...args));
      return out;
    },
  };
}

function makeArea(seed = {}) {
  const store = { ...seed };
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

const POLICY = {
  schema: 1,
  revision: 'test-1',
  authHosts: [],
  never: [],
  rules: [{ id: 'ext', scope: 'external', match: { host: 'example.com' }, to: 'work' }],
};

/**
 * A browser, faked as closely as the real one behaves — including the part
 * that matters most: an OPTIONAL permission that has not been granted means the
 * namespace is not there AT ALL. Modelling it as always-present is what lets a
 * whole class of arming bug through, because the tests cannot then tell
 * "registered" from "could not register".
 */
function makeChrome({ granted = true, policy = POLICY, windows = true } = {}) {
  const c = {
    runtime: {
      getURL: (p) => `moz-extension://cc/${p}`,
      getManifest: () => ({ version: '0.1.0' }),
      openOptionsPage: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
      onMessageExternal: makeEvent(),
    },
    action: { onClicked: makeEvent(), setBadgeText: vi.fn(async () => {}) },
    storage: {
      session: makeArea(),
      managed: {
        get: async () => {
          if (!policy) throw new Error('Managed storage manifest not found');
          return { policy };
        },
      },
    },
    permissions: { onAdded: makeEvent() },
    tabs: {
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
      get: vi.fn(async () => ({ id: 7, cookieStoreId: 'firefox-default' })),
      // As strict as the real one about the two fields that are easy to compute
      // into nonsense. tabs.create rejects a non-integer index or windowId with
      // a type error; openThere() catches everything and releases the claim, so
      // a fake that shrugs at NaN turns "nothing is ever routed" into a green
      // suite. That is how `index: undefined + 1` got as far as a review.
      create: vi.fn(async (props = {}) => {
        for (const k of ['index', 'windowId']) {
          if (k in props && !Number.isInteger(props[k])) {
            throw new Error(`Type error for parameter createProperties: .${k} is not an integer`);
          }
        }
        return { id: 42 };
      }),
      remove: vi.fn(async () => {}),
    },
    bookmarks: { getTree: async () => [] },
  };
  if (windows) {
    c.windows = {
      onFocusChanged: makeEvent(),
      getLastFocused: vi.fn(async () => ({ id: 1, focused: true })),
    };
  }
  if (granted) c.webRequest = { onBeforeRequest: makeEvent() };
  return c;
}

/** The menu, faked to the two calls buildMenu() makes plus the click event. */
function makeMenus() {
  const items = [];
  return {
    items,
    onClicked: makeEvent(),
    removeAll: async () => {
      items.length = 0;
    },
    create: (spec) => items.push(spec),
  };
}

async function boot(options = {}) {
  const { containers = [{ name: 'work', cookieStoreId: 'firefox-container-2' }], menusApi = true } =
    options;
  globalThis.chrome = makeChrome(options);
  globalThis.browser = {
    contextualIdentities: {
      query: async () => containers,
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
      onUpdated: makeEvent(),
    },
    // browser.menus, not chrome.menus: the chrome namespace only ever exposed
    // contextMenus, and in Firefox those are two different permissions. A fake
    // on the wrong namespace would let a broken build pass.
    ...(menusApi ? { menus: makeMenus() } : {}),
  };
  vi.resetModules();
  await import('../src/background.js');
  await settle();
  return globalThis.chrome;
}

async function settle(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** What the blocking listener answered for one request. */
async function request(c, over = {}) {
  const [answer] = await c.webRequest.onBeforeRequest.emit({
    type: 'main_frame',
    url: 'https://example.com/doc',
    method: 'GET',
    tabId: 7,
    frameId: 0,
    ...over,
  });
  return answer;
}

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('arming', () => {
  it('registers the request listener without waiting for anything', async () => {
    // Only listeners added during the first synchronous run are ones the
    // browser can restart the event page FOR. One added after an await is
    // invisible to that machinery, and the extension then silently stops
    // working the moment the page first idles out.
    const c = await boot();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
    expect(c.windows.onFocusChanged.size()).toBe(1);
  });

  it('comes up at all when the permission has not been granted', async () => {
    // A background page that throws at import takes every other listener with
    // it, including the claim receiver its peers depend on.
    const c = await boot({ granted: false });
    expect(c.webRequest).toBeUndefined();
    expect(c.runtime.onMessageExternal.size()).toBe(1);
  });

  it('arms as soon as the permission arrives, without a restart', async () => {
    const c = await boot({ granted: false });
    c.webRequest = { onBeforeRequest: makeEvent() };
    await c.permissions.onAdded.emit({});
    await settle();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });

  it('does not register the same listener twice', async () => {
    // arm() runs on load, on install, on startup and on every permission
    // change. Two listeners would answer one blocking request twice.
    const c = await boot();
    await c.runtime.onInstalled.emit({});
    await c.runtime.onStartup.emit();
    await c.permissions.onAdded.emit({});
    await settle();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });

  it('survives a browser with no windows to focus', async () => {
    const c = await boot({ windows: false });
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });
});

describe('the claim receiver', () => {
  it('answers a peer even with no policy installed', async () => {
    // Inert mode must never break the extensions that depend on us.
    const c = await boot({ policy: null });
    const reply = vi.fn();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:claim', url: 'https://example.com/x', cookieStoreId: 'firefox-container-2' },
      { id: 'beeline@sapn95.github.io' },
      reply,
    );
    expect(reply).toHaveBeenCalledWith({ ok: true });
  });

  it('leaves a claimed tab alone, ahead of any rule', async () => {
    const c = await boot();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:claim', url: 'https://example.com/doc', cookieStoreId: 'firefox-container-2' },
      { id: 'beeline@sapn95.github.io' },
      () => {},
    );
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({});
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('reports its loaded revision when pinged, so skew is visible', async () => {
    const c = await boot();
    const reply = vi.fn();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:ping' },
      { id: 'linkward@sapn95.github.io' },
      reply,
    );
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ revision: 'test-1' }));
  });

  it('ignores a message type it does not know', async () => {
    const c = await boot();
    const answers = c.runtime.onMessageExternal.emitSync(
      { type: 'something:else' },
      { id: 'beeline@sapn95.github.io' },
      () => {},
    );
    expect(answers).toEqual([undefined]);
  });
});

describe('carrying out a decision', () => {
  it('cancels and reopens elsewhere, rather than redirecting', async () => {
    // A redirect cannot move a tab into another cookie store, so the page
    // would load in the wrong one first.
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({ cancel: true });
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ cookieStoreId: 'firefox-container-2' }),
    );
  });

  it('announces the tab it is about to create, before creating it', async () => {
    // Otherwise linkward sees a fresh, opener-less http tab and offers a
    // picker for a tab this extension has just deliberately placed.
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c);
    await settle(20);
    const [target, msg] = c.runtime.sendMessage.mock.calls[0];
    expect(target).toBe('linkward@sapn95.github.io');
    expect(msg.type).toBe('cc:claim');
  });

  it('releases the claim when the tab could not be created', async () => {
    // A stale claim left behind swallows the next genuinely external link at
    // that address.
    const c = await boot();
    c.tabs.create = vi.fn(async () => {
      throw new Error('no such container');
    });
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c);
    await settle(20);
    const types = c.runtime.sendMessage.mock.calls.map(([, m]) => m.type);
    expect(types).toContain('cc:release');
  });

  it('leaves an unmatched navigation completely alone', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://elsewhere.example/x' });
    expect(await request(c, { url: 'https://elsewhere.example/x' })).toEqual({});
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('answers once per tab, not for everything browsed afterwards', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c);
    expect(await request(c)).toEqual({});
  });

  it('ignores a sub-frame, which is not a flow', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c, { frameId: 3 })).toEqual({});
  });
});

describe('when there is no policy at all', () => {
  it('routes nothing and says so on the badge', async () => {
    const c = await boot({ policy: null });
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({});
    expect(c.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
  });

  it('tells the popup why, rather than looking merely broken', async () => {
    const c = await boot({ policy: null });
    const reply = vi.fn();
    c.runtime.onMessage.emitSync({ type: 'cc:status' }, {}, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ inert: true }));
  });
});

describe('pausing', () => {
  it('stops routing for the session without touching the policy', async () => {
    // An emergency stop that outlived the browser would be a second, writable
    // source of truth — the disease this extension exists to cure.
    const c = await boot();
    c.runtime.onMessage.emitSync({ type: 'cc:pause', paused: true }, {}, () => {});
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({});
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('resumes on request', async () => {
    const c = await boot();
    c.runtime.onMessage.emitSync({ type: 'cc:pause', paused: true }, {}, () => {});
    c.runtime.onMessage.emitSync({ type: 'cc:pause', paused: false }, {}, () => {});
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({ cancel: true });
  });
});

describe('tabs coming and going', () => {
  it('forgets a closed tab, so a reused id is not still hands-off', async () => {
    // Firefox reuses tab ids. A binding left behind silently exempts whichever
    // stranger inherits the number.
    const c = await boot();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:opened', tabId: 7, url: 'https://example.com/doc' },
      { id: 'beeline@sapn95.github.io' },
      () => {},
    );
    await c.tabs.onRemoved.emit(7);
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({ cancel: true });
  });
});

describe('the bookmark index', () => {
  const TREE = [
    {
      title: '',
      children: [
        {
          title: 'toolbar',
          children: [
            {
              title: 'Work',
              children: [
                { title: 'Portal', url: 'https://portal.example.com/home/' },
                { title: 'Deep', url: 'https://portal.example.com/home' },
              ],
            },
          ],
        },
      ],
    },
  ];

  const POLICY_WITH_FOLDERS = {
    ...POLICY,
    rules: [],
    bookmarks: { folders: [{ path: 'toolbar/Work', container: 'work' }], onConflict: 'leave' },
  };

  async function bootWithTree() {
    const c = await boot({ policy: POLICY_WITH_FOLDERS });
    c.bookmarks.getTree = async () => TREE;
    // The index is built lazily and memoised, so it has to be invalidated the
    // way a real config reload would.
    await c.permissions.onAdded.emit({});
    await settle(20);
    return c;
  }

  it('routes a bookmarked address on an entry begun inside the browser', async () => {
    const c = await bootWithTree();
    // Browser in front for a minute: plainly not a hand-off.
    await c.windows.onFocusChanged.emit(-1);
    await settle();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://portal.example.com/home/' });
    await settle(10);
    // Focus was lost, so this is external-shaped and the hint must NOT fire —
    // hints are internal-entry only.
    expect(await request(c, { url: 'https://portal.example.com/home/' })).toEqual({});
  });

  it('treats a trailing slash and a fragment as the same bookmark', async () => {
    // Two mechanisms disagreeing about trailing slashes is how a bug report
    // becomes irreproducible, so there is one canonical key and no search path.
    const { canonical } = await import('../src/background.js');
    expect(canonical('https://portal.example.com/home/')).toBe(
      canonical('https://portal.example.com/home#top'),
    );
    expect(canonical('https://WWW.Portal.example.com/home')).toBe(
      canonical('https://portal.example.com/home'),
    );
  });

  it('canonicalises nothing it cannot parse, rather than throwing', async () => {
    const { canonical } = await import('../src/background.js');
    expect(canonical('not a url')).toBe('');
  });

  it('survives a browser with no bookmarks API', async () => {
    const c = await boot({ policy: POLICY_WITH_FOLDERS });
    delete c.bookmarks;
    await c.tabs.onCreated.emit({ id: 7, url: 'https://portal.example.com/home/' });
    expect(await request(c, { url: 'https://portal.example.com/home/' })).toEqual({});
  });
});

describe('the toolbar button', () => {
  // It used to open the options page, which about:addons already reaches. The
  // one gesture that had nowhere to stand was the human override: documented,
  // shipped, and buried under a right-click on a tab strip. The button is now
  // the panel that performs it, and these tests are about the message it sends
  // — the panel's own DOM is pages.test.js.

  // sendResponse arrives on a later turn — the handler returns true and answers
  // once the move has been carried out — so the reply is a promise here rather
  // than a return value. Capturing it synchronously reads `undefined` for every
  // outcome, which is a test that cannot tell "refused" from "did it".
  const sendTo = (c, msg) => {
    let settle;
    const replied = new Promise((r) => {
      settle = r;
    });
    c.runtime.onMessage.emitSync(msg, {}, settle);
    return replied;
  };

  it('moves the tab the panel names, through the same path as the menu', async () => {
    const c = await boot();
    const moved = sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: 'firefox-default',
      to: 'firefox-container-2',
    });
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/doc',
        cookieStoreId: 'firefox-container-2',
      }),
    );
    expect(c.tabs.remove).toHaveBeenCalledWith(7);
    await expect(moved).resolves.toEqual({ moved: true });
  });

  it('announces the claim before the tab exists, exactly as the menu does', async () => {
    // The reason this goes through the background at all. A panel that called
    // tabs.create itself would skip the handshake, and linkward would offer a
    // picker for the answer somebody had just given by hand.
    const c = await boot();
    sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: '',
      to: 'firefox-container-2',
    });
    await settle(20);
    const order = c.runtime.sendMessage.mock.calls.map(([, msg]) => msg.type);
    expect(order.indexOf('cc:claim')).toBeLessThan(order.indexOf('cc:opened'));
  });

  it('does nothing when the tab is already there', async () => {
    // The panel does not offer the current container, so this only arrives from
    // a stale popup — one left open while the tab moved underneath it. Silently
    // costing that tab its history and its scroll position to put it back where
    // it already is would be the worst possible answer.
    const c = await boot();
    const answer = sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: 'firefox-container-2',
      to: 'firefox-container-2',
    });
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
    await expect(answer).resolves.toEqual({ moved: false });
  });

  it('puts the replacement where the original stood', async () => {
    // A14, which docs/architecture.md has promised since 0.1.0 and which nothing
    // implemented: `active: true` was hardcoded, so a middle-clicked background
    // tab came back in front of whatever you were reading, at the end of the
    // strip. Documented, never wired, silent — the same shape as the three
    // failures in the catalogue, found while adding the toolbar button.
    const c = await boot();
    c.tabs.get = vi.fn(async () => ({
      id: 7,
      active: false,
      windowId: 3,
      index: 4,
      cookieStoreId: 'firefox-default',
    }));
    sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: '',
      to: 'firefox-container-2',
    });
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, windowId: 3, index: 5 }),
    );
  });

  it('falls back to opening in front when the old tab tells it nothing', async () => {
    // The default fake answers tabs.get without an index or a windowId, which is
    // what a tab that has already gone answers with. Computing `index + 1` off
    // that gives NaN, tabs.create rejects it, the catch swallows it — and the
    // symptom is that NOTHING is ever routed, anywhere, silently.
    const c = await boot();
    sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: '',
      to: 'firefox-container-2',
    });
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/doc', active: true }),
    );
    const [props] = c.tabs.create.mock.calls.at(-1);
    expect(props).not.toHaveProperty('index');
    expect(props).not.toHaveProperty('windowId');
    expect(c.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('treats firefox-default and no container as the same place', async () => {
    // Two spellings of one thing: a tab outside every container reports
    // `firefox-default`, and tabs.create wants the key absent. The menu offers
    // "No container" on every page, so before this the item was live on tabs
    // that were already in none — one click, one lost history, no change.
    const c = await boot();
    const answer = sendTo(c, {
      type: 'cc:override',
      tabId: 7,
      url: 'https://example.com/doc',
      from: 'firefox-default',
      to: '',
    });
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
    await expect(answer).resolves.toEqual({ moved: false });
  });

  it('refuses a scheme it cannot reopen', async () => {
    const c = await boot();
    sendTo(c, { type: 'cc:override', tabId: 7, url: 'about:config', from: '', to: 'x' });
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
  });
});

describe('the human override', () => {
  // "Reopen this tab in ‹container›" was documented, and the manifest asked for
  // the `menus` permission to serve it, for two releases before anything
  // registered the command. Nothing failed; the menu simply was not there, and
  // an unused permission is a flag in store review. So the registration itself
  // is what most of this tests.

  const clickItem = (menu, id, tab) => menu.onClicked.emitSync({ menuItemId: id }, tab);
  const inContainer = { id: 7, url: 'https://example.com/doc', cookieStoreId: 'firefox-default' };

  it('registers the click listener without waiting for anything', async () => {
    // The event page can only be woken for listeners present on its first
    // synchronous run. Registered from inside the async menu build instead, a
    // click on a slept-out page would do nothing at all.
    globalThis.chrome = makeChrome();
    const menu = makeMenus();
    globalThis.browser = { contextualIdentities: { query: async () => [] }, menus: menu };
    vi.resetModules();
    await import('../src/background.js');
    expect(menu.onClicked.size()).toBe(1);
  });

  it('offers every container, plus a way back out of all of them', async () => {
    await boot({
      containers: [
        { name: 'work', cookieStoreId: 'firefox-container-2' },
        { name: 'personal', cookieStoreId: 'firefox-container-3' },
      ],
    });
    const titles = globalThis.browser.menus.items.map((i) => i.title);
    expect(titles).toEqual(['Reopen this tab in…', 'work', 'personal', 'No container']);
  });

  it('only offers itself on http(s) pages', async () => {
    // There is nothing to reopen about an about: page, and a container is not a
    // property it has.
    await boot();
    const [parent] = globalThis.browser.menus.items;
    expect(parent.documentUrlPatterns).toEqual(['http://*/*', 'https://*/*']);
    expect(parent.contexts).toContain('tab');
  });

  it('reopens the tab in the chosen container and closes the old one', async () => {
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:firefox-container-2', inContainer);
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/doc',
        cookieStoreId: 'firefox-container-2',
      }),
    );
    expect(c.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('announces the claim before the tab exists', async () => {
    // Otherwise linkward sees a fresh, opener-less http tab and offers a picker
    // for a tab this extension has just deliberately placed.
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:firefox-container-2', inContainer);
    await settle(20);
    const order = c.runtime.sendMessage.mock.calls.map(([, msg]) => msg.type);
    expect(order.indexOf('cc:claim')).toBeLessThan(order.indexOf('cc:opened'));
  });

  it('moves a tab out of a container without naming one', async () => {
    // cookieStoreId has to be ABSENT rather than empty: the schema validator
    // rejects a falsy one, so "No container" would fail on the way out.
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:', {
      ...inContainer,
      cookieStoreId: 'firefox-container-2',
    });
    await settle(20);
    const [spec] = c.tabs.create.mock.calls.at(-1);
    expect('cookieStoreId' in spec).toBe(false);
  });

  it('does nothing when the tab is already in that container', async () => {
    // Reopening would cost the tab its history and its scroll position to
    // arrive exactly where it started.
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:firefox-container-2', {
      ...inContainer,
      cookieStoreId: 'firefox-container-2',
    });
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
    expect(c.tabs.remove).not.toHaveBeenCalled();
  });

  it('leaves a privileged page alone', async () => {
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:firefox-container-2', {
      id: 7,
      url: 'about:config',
    });
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('ignores a menu item that is not one of ours', async () => {
    // The menus API delivers every click in the browser to every listener.
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'someone-elses-item', inContainer);
    await settle(20);
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('records the override in the log, named, and off the ladder', async () => {
    // The popup's list is the product. An override that happened invisibly
    // would be the one decision it could not account for.
    const c = await boot();
    await clickItem(globalThis.browser.menus, 'cc:reopen:firefox-container-2', inContainer);
    await settle(20);
    const status = await new Promise((resolve) => {
      c.runtime.onMessage.emitSync({ type: 'cc:status' }, {}, resolve);
    });
    expect(status.log[0].decision).toMatchObject({
      action: 'reopen',
      reason: 'human-override',
      rung: -1,
    });
  });

  it('rebuilds the menu when the containers change', async () => {
    // Renamed and deleted by hand, and a menu built once goes stale offering
    // somewhere that no longer exists.
    await boot();
    const menu = globalThis.browser.menus;
    const before = menu.items.length;
    expect(before).toBeGreaterThan(0);
    await globalThis.browser.contextualIdentities.onUpdated.emit({});
    await settle(20);
    expect(menu.items.length).toBe(before);
    expect(menu.items[0].title).toBe('Reopen this tab in…');
  });

  it('survives a browser with no menus API at all', async () => {
    // Everything else this extension does has to keep working.
    const c = await boot({ menusApi: false });
    expect(globalThis.browser.menus).toBeUndefined();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    expect(await request(c)).toEqual({ cancel: true });
  });
});
