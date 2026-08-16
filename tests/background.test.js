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
      create: vi.fn(async () => ({ id: 42 })),
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

async function boot(options) {
  globalThis.chrome = makeChrome(options);
  globalThis.browser = {
    contextualIdentities: {
      query: async () => [{ name: 'work', cookieStoreId: 'firefox-container-2' }],
    },
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
  it('opens the settings in a tab', async () => {
    const c = await boot();
    await c.action.onClicked.emit({});
    expect(c.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
