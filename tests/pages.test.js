// @vitest-environment jsdom
//
// The two pages. Small files, and the picker is the one place in this
// extension where hostile input meets a DOM: it is web-accessible, so its query
// string arrived from somewhere that is not us.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../src/lib/config.js';
import { join } from 'node:path';

const html = (p) => readFileSync(join(process.cwd(), p), 'utf8').replace(/<!doctype html>/i, '');

const CONTAINERS = [
  { name: 'work', cookieStoreId: 'firefox-container-2', colorCode: '#ff0000' },
  { name: 'personal', cookieStoreId: 'firefox-container-1', colorCode: '#00ff00' },
];

// Two popup states both describes below need: nothing installed, and a policy
// that is loaded and deciding.
const NO_POLICY = { inert: true, errors: [], paused: false, log: [] };
const LOADED = {
  inert: false,
  errors: [],
  paused: false,
  log: [],
  config: { revision: 'r1', dryRun: true, rules: [] },
};

async function mountPicker(query) {
  document.documentElement.innerHTML = html('src/pick/pick.html');
  globalThis.location = new URL(`moz-extension://cc/pick/pick.html${query}`);
  globalThis.chrome = {
    tabs: {
      getCurrent: vi.fn(async () => ({ id: 5 })),
      create: vi.fn(async () => ({ id: 9 })),
      remove: vi.fn(async () => {}),
    },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  };
  globalThis.browser = { contextualIdentities: { query: async () => CONTAINERS } };
  vi.resetModules();
  await import('../src/pick/pick.js');
  await settle();
}

async function settle(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);
const buttons = () => [...document.querySelectorAll('#choices button')];

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('the picker', () => {
  it('shows the address as text, never as a link', async () => {
    // This page is web-accessible: whatever is in the query string came from
    // somewhere that is not us, and a clickable version of it would be a
    // redirect service with our name on it.
    await mountPicker('?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1');
    expect($('url').textContent).toBe('https://example.com/a?b=1');
    expect($('url').querySelector('a')).toBeNull();
  });

  it('does not render markup that arrived in the query string', async () => {
    await mountPicker('?url=' + encodeURIComponent('https://example.com/<img src=x onerror=1>'));
    expect($('url').querySelector('img')).toBeNull();
    expect($('url').textContent).toContain('<img');
  });

  it('offers every container, plus opening without one', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    expect(buttons().map((b) => b.textContent)).toEqual([
      expect.stringContaining('work'),
      expect.stringContaining('personal'),
      expect.stringContaining('No container'),
    ]);
  });

  it('marks the preselected container without removing the others', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F&preselect=personal');
    const marked = buttons().filter((b) => b.className === 'preselect');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('personal');
    expect(buttons()).toHaveLength(3);
  });

  it('claims the tab before creating it, then closes its own', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    buttons()[0].click();
    await settle(30);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      'linkward@sapn95.github.io',
      expect.objectContaining({ type: 'cc:claim' }),
    );
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ cookieStoreId: 'firefox-container-2' }),
    );
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5);
  });

  it('opens without a container when that is what was chosen', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    buttons()[2].click();
    await settle(30);
    const [args] = chrome.tabs.create.mock.calls[0];
    expect(args.cookieStoreId).toBeUndefined();
  });

  it('does not close the old tab when the new one could not be made', async () => {
    // Closing it anyway would leave somebody with nothing at all.
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    chrome.tabs.create = vi.fn(async () => {
      throw new Error('no');
    });
    buttons()[0].click();
    await settle(30);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('picks with the number keys', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    await settle(30);
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ cookieStoreId: 'firefox-container-1' }),
    );
  });

  it('closes the tab on Escape', async () => {
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(30);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5);
  });

  it('leaves modified keys to the browser', async () => {
    // Taking ⌘C from somebody copying the address off this page would be its
    // own small betrayal.
    await mountPicker('?url=https%3A%2F%2Fexample.com%2F');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true }));
    await settle(20);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('survives a browser that has no containers at all', async () => {
    document.documentElement.innerHTML = html('src/pick/pick.html');
    globalThis.location = new URL(
      'moz-extension://cc/pick/pick.html?url=https%3A%2F%2Fa.example%2F',
    );
    globalThis.chrome = {
      tabs: { getCurrent: vi.fn(async () => null), create: vi.fn(), remove: vi.fn() },
      runtime: { sendMessage: vi.fn(async () => ({})) },
    };
    globalThis.browser = undefined;
    vi.resetModules();
    await import('../src/pick/pick.js');
    await settle();
    // Still one button: opening without a container is always available.
    expect(buttons()).toHaveLength(1);
  });
});

describe('the popup', () => {
  async function mountPopup(status) {
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        sendMessage: vi.fn(async () => status),
        reload: vi.fn(),
      },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();
  }

  const loaded = {
    inert: false,
    paused: false,
    config: { revision: 'policy-abc', rules: [{ id: 'a' }], dryRun: false },
    log: [
      {
        at: 1,
        url: 'https://example.com/x',
        decision: { action: 'leave', rung: 6, reason: 'no-match' },
      },
    ],
  };

  it('shows the loaded revision, which is the honest answer to a boot-time read', async () => {
    // Managed storage is not live. A revision and an age on screen beats a
    // claim of liveness that is false.
    await mountPopup(loaded);
    expect($('revision').textContent).toBe('policy-abc');
    expect($('state').textContent).toContain('1 rule');
  });

  it('says plainly when no policy is installed', async () => {
    // Silently doing nothing looks exactly like silently doing the wrong thing.
    await mountPopup({ inert: true, errors: ['no managed policy installed'], log: [] });
    expect($('revision').textContent).toMatch(/no policy installed/i);
  });

  it('says when it is deciding but not enforcing', async () => {
    await mountPopup({ ...loaded, config: { ...loaded.config, dryRun: true } });
    expect($('state').textContent).toMatch(/dry run/i);
  });

  it('lists recent decisions with the rung that produced them', async () => {
    await mountPopup(loaded);
    const row = document.querySelector('#log li');
    expect(row.textContent).toContain('https://example.com/x');
    expect(row.textContent).toContain('leave');
  });

  it('says so when the background page did not answer', async () => {
    await mountPopup(null);
    expect($('revision').textContent).toMatch(/did not answer/i);
  });

  it('offers a pause that is scoped to the session', async () => {
    await mountPopup(loaded);
    $('pause').click();
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cc:pause', paused: true }),
    );
  });
});

describe('the setup screen a new install lands on', () => {
  // The whole reason this exists: "no policy installed" is a diagnosis, and a
  // person who has just installed this from the store needs the next step. The
  // author hit that dead end himself, on the day it went public.

  async function mountPopup(status) {
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.chrome = {
      runtime: {
        id: 'container-commander@sapn95.github.io',
        getManifest: () => ({ version: '9.9.9' }),
        reload: vi.fn(),
        sendMessage: vi.fn(async (m) => (m?.type === 'cc:pause' ? { paused: m.paused } : status)),
      },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();
  }

  it('comes out when there is no policy, and stays away when there is', async () => {
    await mountPopup(NO_POLICY);
    expect($('setup').hidden).toBe(false);

    await mountPopup({
      inert: false,
      errors: [],
      paused: false,
      log: [],
      config: { revision: 'r1', dryRun: false, rules: [] },
    });
    expect($('setup').hidden).toBe(true);
  });

  it('names the file after the extension id, which is what makes Firefox deliver it', async () => {
    await mountPopup(NO_POLICY);
    const path = $('managed-path').textContent;
    expect(path).toContain('container-commander@sapn95.github.io');
    expect(path.length).toBeGreaterThan(20);
  });

  it('offers a sample policy the extension would actually accept', async () => {
    // A sample that gets rejected is worse than no sample: it sends a new user
    // to debug the one thing they were told to trust.
    await mountPopup(NO_POLICY);
    const sample = JSON.parse($('sample').textContent);

    expect(sample.name).toBe('container-commander@sapn95.github.io');
    expect(sample.type).toBe('storage');
    expect(validateConfig(sample.data.policy).errors).toEqual([]);
  });

  it('starts in dry run, so a first policy cannot move a tab by surprise', async () => {
    await mountPopup(NO_POLICY);
    expect(JSON.parse($('sample').textContent).data.policy.dryRun).toBe(true);
  });

  it('gives each platform its own path, because that is the one thing you cannot guess', async () => {
    // A Linux reader handed a ~/Library path is exactly the dead end this
    // screen exists to close, one step further along.
    const ua = (value) =>
      Object.defineProperty(globalThis.navigator, 'userAgent', {
        value,
        configurable: true,
      });

    ua('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/153.0');
    await mountPopup(NO_POLICY);
    expect($('managed-path').textContent).toContain('.mozilla/managed-storage');

    ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/153.0');
    await mountPopup(NO_POLICY);
    expect($('managed-path').textContent).toContain('HKEY_CURRENT_USER');
    // Windows keeps a POINTER to the file, not the file, and a reader told to
    // "create this" without that sentence writes JSON into a registry key.
    expect($('managed-note').textContent).toMatch(/registry/i);

    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/153.0');
  });

  it('says so when the clipboard refuses, rather than looking dead', async () => {
    // A copy button that silently does nothing is this screen repeating the
    // mistake it was built to fix.
    await mountPopup(NO_POLICY);
    const button = document.querySelector('.copy');

    globalThis.navigator.clipboard = { writeText: async () => {} };
    button.click();
    await settle();
    expect(button.textContent).toBe('Copied');

    await new Promise((r) => setTimeout(r, 1700));
    globalThis.navigator.clipboard = {
      writeText: async () => {
        throw new Error('denied');
      },
    };
    button.click();
    await settle();
    expect(button.textContent).toMatch(/select it/i);
  });

  it('sends the reader to Reload rather than to a browser restart', async () => {
    // runtime.reload() restarts the add-on, and the add-on starting is exactly
    // when managed storage is read. Telling a stranger to restart Firefox when
    // a button on the same page does it costs them a minute for nothing.
    await mountPopup(NO_POLICY);
    expect(document.querySelector('.steps').textContent).toMatch(/Reload policy/);
    expect($('reload')).not.toBeNull();
  });
});

describe('the permission without which nothing can ever be decided', () => {
  // The one that actually bit. webRequest/webRequestBlocking/<all_urls> are
  // OPTIONAL in the manifest, nothing in src/ ever asked for them, and
  // armRequests() swallows the resulting failure — so the extension registered
  // no listener, saw no navigation, decided nothing, and reported "Nothing
  // decided yet this session", which is what a quiet day looks like too.
  // PRIVACY.md had been promising the request was made "from the add-on's own
  // page" for three releases.

  async function mount({ granted, status = LOADED, request = async () => true } = {}) {
    document.documentElement.innerHTML = html('src/popup/popup.html');
    // jsdom has no navigation, and the granted path reloads the page. Left
    // alone it throws into an unhandled rejection that the suite prints and
    // nobody reads — which is the shape of thing that later hides a real one.
    globalThis.location = { reload: vi.fn(), href: 'moz-extension://cc/popup/popup.html' };
    globalThis.chrome = {
      runtime: {
        id: 'container-commander@sapn95.github.io',
        getManifest: () => ({ version: '9.9.9' }),
        reload: vi.fn(),
        sendMessage: vi.fn(async (m) => (m?.type === 'cc:pause' ? { paused: m.paused } : status)),
      },
      permissions: { contains: async () => granted, request: vi.fn(request) },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();
  }

  it('is asked for on the page, which is where PRIVACY.md says it is asked for', async () => {
    await mount({ granted: false });
    expect($('grant').hidden).toBe(false);
    expect($('grant-button')).not.toBeNull();
  });

  it('stays out of the way once it has been granted', async () => {
    await mount({ granted: true });
    expect($('grant').hidden).toBe(true);
  });

  it('asks for everything in ONE call, because a second one always fails', async () => {
    // permissions.request must run inside a user gesture, and a handler stops
    // being user-initiated the moment it awaits. Splitting this into two calls
    // is a bug that only shows up in a real browser.
    await mount({ granted: false });
    $('grant-button').click();
    await settle();

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    const [asked] = chrome.permissions.request.mock.calls[0];
    expect(asked.origins).toEqual(['<all_urls>']);
    expect(asked.permissions).toEqual(['webRequest', 'webRequestBlocking']);
    // and the page in front of you is stale the moment it is granted
    expect(globalThis.location.reload).toHaveBeenCalled();
  });

  it('says what happened when the grant is refused, rather than going quiet', async () => {
    await mount({ granted: false, request: async () => false });
    $('grant-button').click();
    await settle();

    expect($('grant-note').textContent).toMatch(/refused|dismissed/i);
    expect($('grant-button').disabled).toBe(false);
    expect($('grant-note').textContent).toMatch(/about:addons/);
  });

  it('rewrites the empty log, which otherwise reads as a quiet day', async () => {
    // This is the sentence that cost an afternoon: a loaded policy, an empty
    // list, and no hint that the list can never fill.
    await mount({ granted: false });
    expect($('log-empty').textContent).toMatch(/until watching is turned on/i);

    await mount({ granted: true });
    expect($('log-empty').textContent).toMatch(/nothing decided yet/i);
  });

  it('does not claim a grant when the browser cannot answer', async () => {
    // A wrong "yes" hides exactly the state this is here to report.
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.chrome = {
      runtime: {
        id: 'x@y',
        getManifest: () => ({ version: '9.9.9' }),
        reload: vi.fn(),
        sendMessage: vi.fn(async () => LOADED),
      },
      permissions: {
        contains: async () => {
          throw new Error('no such API');
        },
        request: vi.fn(),
      },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();

    expect($('grant').hidden).toBe(false);
  });
});
