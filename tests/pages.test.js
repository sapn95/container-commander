// @vitest-environment jsdom
//
// The two pages. Small files, and the picker is the one place in this
// extension where hostile input meets a DOM: it is web-accessible, so its query
// string arrived from somewhere that is not us.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = (p) => readFileSync(join(process.cwd(), p), 'utf8').replace(/<!doctype html>/i, '');

const CONTAINERS = [
  { name: 'work', cookieStoreId: 'firefox-container-2', colorCode: '#ff0000' },
  { name: 'personal', cookieStoreId: 'firefox-container-1', colorCode: '#00ff00' },
];

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
