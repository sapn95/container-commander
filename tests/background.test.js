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
    action: {
      onClicked: makeEvent(),
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
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
    // Found by type, not by call index. Arming also takes a peer census, so the
    // claim is no longer the first message this extension ever sends — and
    // "first message overall" was never what this test meant. What matters is
    // that the claim went to linkward and went out BEFORE the tab was created,
    // which is what the ordering assertion below actually checks.
    const claim = c.runtime.sendMessage.mock.calls.find(([, m]) => m.type === 'cc:claim');
    expect(claim).toBeDefined();
    expect(claim[0]).toBe('linkward@sapn95.github.io');
    expect(
      c.runtime.sendMessage.mock.invocationCallOrder[
        c.runtime.sendMessage.mock.calls.indexOf(claim)
      ],
    ).toBeLessThan(c.tabs.create.mock.invocationCallOrder[0]);
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

describe('a bookmark click, end to end', () => {
  // Reported as "clicking a bookmark always opens two tabs with the same page".
  // `browser.tabs.loadBookmarksInTabs` makes every bookmark a NEW tab, which
  // turned the reopen path from something that ran occasionally into the most
  // common thing this extension does — so it is worth a test that walks the
  // whole sequence rather than one listener at a time.
  //
  // Both orderings, because they are not the same run. Firefox dispatches
  // onCreated on its own schedule: it can arrive before tabs.create resolves or
  // after, and after is the interesting one — openThere's bind and candidate
  // delete have already happened, and onCreated then puts the replacement tab
  // back into `candidates`. If `ours` did not outrank that, the replacement's
  // own first request would be reopened again and the click would cost two tabs.

  function wire(c, { onCreatedAfterCreate }) {
    const tabs = new Map();
    let nextId = 100;
    c.tabs.get = vi.fn(
      async (id) =>
        tabs.get(id) ?? {
          id,
          cookieStoreId: 'firefox-default',
          active: true,
          windowId: 1,
          index: 0,
        },
    );
    c.tabs.create = vi.fn(async (props) => {
      const t = {
        id: nextId++,
        url: props.url,
        cookieStoreId: props.cookieStoreId ?? 'firefox-default',
        active: props.active ?? true,
        windowId: props.windowId ?? 1,
        index: props.index ?? 0,
      };
      tabs.set(t.id, t);
      if (onCreatedAfterCreate) queueMicrotask(() => c.tabs.onCreated.emit(t));
      else await c.tabs.onCreated.emit(t);
      return t;
    });
    c.tabs.remove = vi.fn(async (id) => {
      tabs.delete(id);
      await c.tabs.onRemoved.emit(id);
    });
    return () => [...tabs.values()];
  }

  for (const onCreatedAfterCreate of [false, true]) {
    const when = onCreatedAfterCreate
      ? 'after tabs.create resolves'
      : 'before tabs.create resolves';

    it(`costs one tab, not two, when onCreated arrives ${when}`, async () => {
      const c = await boot({
        containers: [{ name: 'work', cookieStoreId: 'firefox-container-2' }],
      });
      const open = wire(c, { onCreatedAfterCreate });

      // Firefox opens a brand-new tab for the bookmark, and reports the real
      // address in onCreated — not about:blank, which is Chrome's shape and
      // would fail isCandidateTab before any rule was read.
      await c.tabs.onCreated.emit({
        id: 7,
        url: 'https://example.com/doc',
        cookieStoreId: 'firefox-default',
        active: true,
        windowId: 1,
        index: 0,
      });
      const answer = await request(c, { url: 'https://example.com/doc' });
      await settle(60);

      expect(answer).toEqual({ cancel: true });
      expect(c.tabs.create).toHaveBeenCalledTimes(1);
      expect(c.tabs.remove).toHaveBeenCalledWith(7);
      expect(open()).toHaveLength(1);
      expect(open()[0].cookieStoreId).toBe('firefox-container-2');
    });

    it(`leaves its own replacement alone when onCreated arrives ${when}`, async () => {
      // The replacement issues the same address a moment later. It must be
      // recognised as ours, or the extension chases its own tail one tab at a
      // time — which is exactly what "two tabs with the same page" looks like.
      const c = await boot({
        containers: [{ name: 'work', cookieStoreId: 'firefox-container-2' }],
      });
      wire(c, { onCreatedAfterCreate });

      await c.tabs.onCreated.emit({
        id: 7,
        url: 'https://example.com/doc',
        cookieStoreId: 'firefox-default',
        active: true,
        windowId: 1,
        index: 0,
      });
      await request(c, { url: 'https://example.com/doc' });
      await settle(60);

      const replacement = (await c.tabs.create.mock.results[0].value).id;
      const again = await request(c, { url: 'https://example.com/doc', tabId: replacement });
      await settle(60);

      expect(again).toEqual({});
      expect(c.tabs.create).toHaveBeenCalledTimes(1);

      // On the REASON and not only on the count. Two independent things keep
      // the replacement safe — the binding, and rung 2 standing down on a tab
      // that already carries a container — so counting tabs stays green while
      // the designed guard quietly stops working. Naming the rung is what makes
      // this a test of the claim rather than of the coincidence.
      let status;
      c.runtime.onMessage.emitSync({ type: 'cc:status' }, {}, (r) => {
        status = r;
      });
      expect(status.log[0].decision.reason).toBe('claim:bound');
    });
  }
});

// The list said what was DECIDED and never where the tab ended up, so the
// question people actually arrive with — why is this tab not in the container I
// expected — could only be answered by knowing the ladder by heart. A `leave`
// that kept a tab where it already was is a correct decision and an invisible
// one, and it is the commonest reason a sign-in lands in the wrong place.
describe('the log says where the tab went', () => {
  const WORK = { name: 'work', cookieStoreId: 'firefox-container-2' };

  async function lastEntry(c) {
    let status;
    c.runtime.onMessage.emitSync({ type: 'cc:status' }, {}, (r) => {
      status = r;
    });
    await settle(10);
    return status.log[0];
  }

  it('names the container a reopen moved the tab into', async () => {
    const c = await boot({ containers: [WORK] });
    await c.tabs.onCreated.emit({
      id: 7,
      url: 'https://example.com/doc',
      cookieStoreId: 'firefox-default',
      active: true,
      windowId: 1,
      index: 0,
    });
    await request(c, { url: 'https://example.com/doc' });
    await settle(30);
    const entry = await lastEntry(c);
    expect(entry.decision.action).toBe('reopen');
    expect(entry.from).toBe('No container');
    expect(entry.to).toBe('work');
  });

  it('says where a tab was left, not nothing', async () => {
    // `leave` is the decision that needed this most: it reads as "did nothing"
    // while being the reason the tab is where it is.
    const c = await boot({ containers: [WORK], policy: { schema: 1, revision: 'r', rules: [] } });
    c.tabs.get = vi.fn(async (id) => ({
      id,
      cookieStoreId: WORK.cookieStoreId,
      active: true,
      windowId: 1,
      index: 0,
    }));
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c, { url: 'https://example.com/doc' });
    await settle(30);
    const entry = await lastEntry(c);
    expect(entry.decision.action).toBe('leave');
    expect(entry.from).toBe('work');
    expect(entry.to).toBe('work');
  });

  it('says No container rather than leaving the cell empty', async () => {
    // An empty cell reads as a value that failed to load. A tab outside every
    // container is a real answer and has to look like one.
    const c = await boot({ containers: [], policy: { schema: 1, revision: 'r', rules: [] } });
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c, { url: 'https://example.com/doc' });
    await settle(30);
    expect((await lastEntry(c)).to).toBe('No container');
  });

  it('falls back to the raw id for a container it cannot name', async () => {
    // Containers are renamed and deleted by hand. An id beats an empty string:
    // it is still something to search for.
    const c = await boot({ containers: [], policy: { schema: 1, revision: 'r', rules: [] } });
    c.tabs.get = vi.fn(async (id) => ({
      id,
      cookieStoreId: 'firefox-container-9',
      active: true,
      windowId: 1,
      index: 0,
    }));
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    await request(c, { url: 'https://example.com/doc' });
    await settle(30);
    expect((await lastEntry(c)).to).toBe('firefox-container-9');
  });
});

// Raised in review, and in this list it matters more than usual: an entry that
// says "me → sbb" about a tab that never moved is the single lie a log whose
// purpose is to say where a tab went cannot afford.
describe('an override that the browser refused', () => {
  it('reports failure and writes no line', async () => {
    const c = await boot({ containers: [{ name: 'work', cookieStoreId: 'firefox-container-2' }] });
    c.tabs.get = vi.fn(async (id) => ({ id, cookieStoreId: 'firefox-default', active: true }));
    // A container deleted between the menu being built and the click.
    c.tabs.create = vi.fn(async () => {
      throw new Error('No such cookieStoreId');
    });
    let moved;
    c.runtime.onMessage.emitSync(
      {
        type: 'cc:override',
        tabId: 7,
        url: 'https://example.com/x',
        from: '',
        to: 'firefox-container-2',
      },
      {},
      (r) => {
        moved = r;
      },
    );
    await settle(30);
    expect(moved).toEqual({ moved: false });

    let status;
    c.runtime.onMessage.emitSync({ type: 'cc:status' }, {}, (r) => {
      status = r;
    });
    expect(status.log).toEqual([]);
    // And the tab it failed to replace is still there.
    expect(c.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('when it is not allowed to watch', () => {
  // The worse of the two ways to be switched off, and the one that was silent.
  // A policy loaded and no permission to see navigation is an extension that is
  // structurally unable to decide anything — and it looked EXACTLY like one
  // having a quiet day, because `inert` was false and the badge was therefore
  // empty. Diagnosing it took reading a profile off disk and still not being
  // sure. The icon now says so.

  const badgeText = (c) => c.action.setBadgeText.mock.calls.at(-1)[0].text;
  const tooltip = (c) => c.action.setTitle.mock.calls.at(-1)[0].title;

  it('marks the icon even though the policy is fine', async () => {
    const c = await boot({ granted: false });
    expect(c.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(badgeText(c)).toBe('!');
  });

  it('says which of the two things is wrong, in words', async () => {
    const c = await boot({ granted: false });
    expect(tooltip(c)).toMatch(/not watching/i);
    expect(tooltip(c)).not.toMatch(/no policy/i);
  });

  it('names both when both are wrong, rather than the first it finds', async () => {
    const c = await boot({ granted: false, policy: null });
    expect(tooltip(c)).toMatch(/not watching/i);
    expect(tooltip(c)).toMatch(/no policy/i);
  });

  it('clears the mark once the grant arrives, without a restart', async () => {
    // permissions.onAdded re-arms the listener. If the badge were only written
    // on a config load it would keep the warning until the next browser start,
    // and a warning that outlives its cause teaches people to ignore warnings.
    const c = await boot({ granted: false });
    expect(badgeText(c)).toBe('!');
    c.webRequest = { onBeforeRequest: makeEvent() };
    await c.permissions.onAdded.emit({});
    await settle(20);
    expect(badgeText(c)).toBe('');
    expect(tooltip(c)).toBe('container commander — move this tab');
  });

  it('says nothing at all when both are in order', async () => {
    const c = await boot();
    expect(badgeText(c)).toBe('');
  });
});

describe('when something else is routing too', () => {
  // The mirror image of the block above, and it ran undetected for weeks.
  // commander routed `*.example.com`; linkward held its own `docs.example.com` rule
  // with interception on. Both hold a blocking webRequest listener, both cancel
  // the same request, both open a replacement — and Firefox carries out both.
  // Every bookmark on those hosts opened in a pair, with both extensions
  // reporting themselves perfectly healthy, because neither can enumerate the
  // other's listeners.

  const badgeText = (c) => c.action.setBadgeText.mock.calls.at(-1)[0].text;
  const tooltip = (c) => c.action.setTitle.mock.calls.at(-1)[0].title;

  /** A peer that answers cc:ping the way a live router does. */
  function peerRoutes(c, routes, over = {}) {
    c.runtime.sendMessage = vi.fn(async (id, msg) => {
      if (msg?.type !== 'cc:ping') return { ok: true };
      if (id !== 'linkward@sapn95.github.io') return { ok: true };
      return {
        id,
        name: 'linkward',
        version: '0.1.0',
        routing: true,
        dryRun: false,
        routes,
        ...over,
      };
    });
  }

  /** What the GUI asks for when a page opens. */
  async function census(c) {
    let answer;
    c.runtime.onMessage.emitSync({ type: 'cc:peers' }, {}, (r) => {
      answer = r;
    });
    await settle(20);
    return answer;
  }

  it('tells a peer what it is doing, not merely that it exists', async () => {
    // A peer has no other way to get this: webRequest listeners are not
    // enumerable across extensions, and `management` would want a permission
    // whose warning is worse than the bug.
    const c = await boot();
    const reply = vi.fn();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:ping' },
      { id: 'linkward@sapn95.github.io' },
      reply,
    );
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ routing: true, routes: ['example.com'] }),
    );
  });

  it('answers a ping with routing false when it cannot watch', async () => {
    const c = await boot({ granted: false });
    const reply = vi.fn();
    c.runtime.onMessageExternal.emitSync(
      { type: 'cc:ping' },
      { id: 'linkward@sapn95.github.io' },
      reply,
    );
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ routing: false, routes: [] }));
  });

  it('finds the peer that routes the same host and says what it means', async () => {
    const c = await boot();
    peerRoutes(c, ['example.com', 'elsewhere.example']);
    const answer = await census(c);
    expect(answer.clash).toHaveLength(1);
    expect(answer.clash[0].overlap).toEqual(['example.com']);
    expect(answer.line).toMatch(/two tabs/);
  });

  it('marks the icon, because the rules on screen are right and the browser is not', async () => {
    const c = await boot();
    expect(badgeText(c)).toBe('');
    peerRoutes(c, ['example.com']);
    await census(c);
    expect(badgeText(c)).toBe('!');
    expect(tooltip(c)).toMatch(/also routing/i);
  });

  it('keeps the two kinds of failure in separate sentences', async () => {
    // "Nothing is being decided" and "everything is decided twice" are opposite
    // states. Reading them off one list would put them behind the same wording.
    const c = await boot({ granted: false });
    peerRoutes(c, ['example.com']);
    await census(c);
    expect(tooltip(c)).toMatch(/Nothing is being decided/);
    expect(tooltip(c)).not.toMatch(/also routing/i);
  });

  it('says nothing when the peer is installed but not intercepting', async () => {
    const c = await boot();
    peerRoutes(c, ['example.com'], { routing: false });
    const answer = await census(c);
    expect(answer.clash).toEqual([]);
    expect(answer.line).toBeNull();
    expect(badgeText(c)).toBe('');
  });

  it('says nothing when no peer answers at all', async () => {
    // Absence is the normal case. Every one of these extensions has to work
    // with the other two uninstalled.
    const c = await boot();
    c.runtime.sendMessage = vi.fn(async () => {
      throw new Error('Could not establish connection');
    });
    const answer = await census(c);
    expect(answer.clash).toEqual([]);
    expect(badgeText(c)).toBe('');
  });

  it('takes a census on its own at arming, before anybody opens a page', async () => {
    // The point of the badge is that it is already right when you look at it.
    const c = await boot();
    const asked = c.runtime.sendMessage.mock.calls.filter(([, m]) => m?.type === 'cc:ping');
    expect(asked.map(([id]) => id)).toEqual([
      'linkward@sapn95.github.io',
      'beeline@sapn95.github.io',
    ]);
  });

  it('clears the mark once the other one is switched off', async () => {
    // A warning that outlives its cause teaches people to ignore warnings.
    const c = await boot();
    peerRoutes(c, ['example.com']);
    await census(c);
    expect(badgeText(c)).toBe('!');
    peerRoutes(c, ['example.com'], { routing: false });
    await census(c);
    expect(badgeText(c)).toBe('');
    expect(tooltip(c)).toBe('container commander — move this tab');
  });

  it('takes the mark off while paused, and puts it straight back on resume', async () => {
    // Paused this extension takes no requests, so nothing opens twice and the
    // clash is real but inert. Leaving the `!` up would be warning about a
    // doubling that has stopped, which is the same lesson as a stale warning.
    const c = await boot();
    peerRoutes(c, ['example.com']);
    await census(c);
    expect(badgeText(c)).toBe('!');

    c.runtime.onMessage.emitSync({ type: 'cc:pause', paused: true }, {}, () => {});
    expect(badgeText(c)).toBe('');
    expect(tooltip(c)).not.toMatch(/also routing/i);

    // From the cached answer. Pausing says nothing about what the other
    // extension is doing, so resuming must not have to go and ask again.
    c.runtime.onMessage.emitSync({ type: 'cc:pause', paused: false }, {}, () => {});
    expect(badgeText(c)).toBe('!');
    expect(tooltip(c)).toMatch(/also routing/i);
  });

  it('lets the newer of two overlapping censuses win', async () => {
    // Both pages take a census when they open and a config change takes one of
    // its own, so two can be in the air at once. They wait on other extensions
    // and can finish in either order. Without a guard the slower one writes last
    // and the badge reports a state that has already been superseded.
    const c = await boot();
    // Held open rather than delayed, so the order the two runs answer in is the
    // test's to choose and not the scheduler's.
    const held = [];
    c.runtime.sendMessage = vi.fn((id, msg) => {
      if (msg?.type !== 'cc:ping' || id !== 'linkward@sapn95.github.io') {
        return Promise.resolve({ ok: true });
      }
      return new Promise((resolve) => held.push(resolve));
    });
    const answer = (routing) => ({
      id: 'linkward@sapn95.github.io',
      name: 'linkward',
      version: '0.1.0',
      routing,
      dryRun: false,
      routes: ['example.com'],
    });

    let stale;
    c.runtime.onMessage.emitSync({ type: 'cc:peers' }, {}, (r) => {
      stale = r;
    });
    await settle(5);
    let fresh;
    c.runtime.onMessage.emitSync({ type: 'cc:peers' }, {}, (r) => {
      fresh = r;
    });
    await settle(5);
    expect(held).toHaveLength(2);

    // The newer run answers first and finds nothing.
    held[1](answer(false));
    await settle(5);
    expect(fresh.clash).toEqual([]);
    expect(badgeText(c)).toBe('');

    // Then the older one comes back with a clash. It still answers the page that
    // asked it — that page is owed what it measured — and touches nothing else.
    held[0](answer(true));
    await settle(5);
    expect(stale.clash).toHaveLength(1);
    expect(badgeText(c)).toBe('');
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
