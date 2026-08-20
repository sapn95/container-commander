// @vitest-environment jsdom
//
// The rule builder.
//
// What is under test is mostly one property: that it agrees with the browser.
// It validates with the extension's own validateConfig and orders with its own
// compile, so a rule it accepts is a rule that loads, and the order it shows is
// the order that runs. A builder that got either wrong would be worse than none
// — it would be a confident wrong answer, and you would only find out from a
// tab opening in the wrong container.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../src/lib/config.js';

const html = (p) => readFileSync(join(process.cwd(), p), 'utf8').replace(/<!doctype html>/i, '');
const $ = (id) => document.getElementById(id);
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const LOADED = {
  inert: false,
  errors: [],
  paused: false,
  log: [],
  config: {
    schema: 1,
    revision: 'r1',
    dryRun: true,
    rules: [{ id: 'wiki', scope: 'any', match: { host: 'wiki.example.com' }, to: 'work' }],
    never: [],
    authHosts: ['login.example-idp.com'],
  },
};

async function mount(status = LOADED, containers = ['work', 'me']) {
  document.documentElement.innerHTML = html('src/edit/edit.html');
  globalThis.chrome = {
    runtime: {
      id: 'container-commander@sapn95.github.io',
      getURL: (p) => `moz-extension://cc/${p}`,
      sendMessage: vi.fn(async () => status),
    },
  };
  globalThis.browser = {
    contextualIdentities: { query: async () => containers.map((name) => ({ name })) },
  };
  globalThis.navigator.clipboard = { writeText: async () => {} };
  vi.resetModules();
  await import('../src/edit/edit.js');
  await settle();
}

const file = () => JSON.parse($('out').textContent);
const rows = () => [...document.querySelectorAll('#rulelist li')].map((li) => li.textContent);

function fill({ pattern, kind = 'host', scope = 'any', to = 'work', id = '' }) {
  $('pattern').value = pattern;
  $('kind').value = kind;
  $('scope').value = scope;
  $('to').value = to;
  $('id').value = id;
  $('add').click();
}

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('starting from what is already loaded', () => {
  it('opens with the live policy, not a blank page', async () => {
    // A builder that started empty would quietly propose deleting the ten rules
    // you already have, and the output looks perfectly reasonable either way.
    await mount();
    expect(rows()).toHaveLength(1);
    expect(file().data.policy.rules).toHaveLength(1);
  });

  it('starts from an empty policy when nothing is installed', async () => {
    await mount({ inert: true, errors: [], paused: false, log: [] });
    expect(rows()).toHaveLength(0);
    expect(file().data.policy.rules).toEqual([]);
  });

  it('offers the containers this browser actually has', async () => {
    await mount(LOADED, ['work', 'me', 'admin']);
    const options = [...$('to').options].map((o) => o.value);
    expect(options).toEqual(['work', 'me', 'admin', 'ask']);
  });
});

describe('agreeing with the browser', () => {
  it('adds a rule and produces a file the extension accepts', async () => {
    await mount();
    fill({ pattern: 'jenkins.example.com', to: 'work', id: 'jenkins' });

    const policy = file().data.policy;
    expect(policy.rules.map((r) => r.id)).toContain('jenkins');
    // The real validator, on the real output. This is the whole point.
    expect(validateConfig(policy).errors).toEqual([]);
  });

  it('shows the compiled order, not the order things were typed', async () => {
    // compile() sorts by specificity, so a regex rule added last can land
    // first. Showing the typed order would be showing something that never runs.
    await mount({ ...LOADED, config: { ...LOADED.config, rules: [] } });
    fill({ pattern: 'a.example.com', id: 'aaa' });
    fill({ pattern: '^https://z\\.example\\.com/deep/path', kind: 'regex', id: 'zzz' });

    const shown = rows().map((t) => t.trim());
    const inFile = file().data.policy.rules.map((r) => r.id);
    expect(shown[0]).toContain('z\\.example\\.com');
    expect(inFile[0]).toBe('zzz');
  });

  it('refuses what the compiler refuses, in the compiler’s own words', async () => {
    // A bare pin on an auth host: shared by every identity, so it pulls
    // somebody else's sign-in into one container halfway through.
    await mount();
    fill({ pattern: 'login.example-idp.com', to: 'work', id: 'bad' });

    expect($('say').textContent).toMatch(/auth host/i);
    expect(rows()).toHaveLength(1);
    expect(file().data.policy.rules.map((r) => r.id)).not.toContain('bad');
  });

  it('refuses ask on an external rule, because that is linkward’s job', async () => {
    await mount();
    fill({ pattern: 'shared.example.com', scope: 'external', to: 'ask', id: 'nope' });

    expect($('say').textContent).toMatch(/internal rule may ask|linkward/i);
    expect(rows()).toHaveLength(1);
  });

  it('refuses a duplicate id rather than silently shadowing one', async () => {
    await mount();
    fill({ pattern: 'other.example.com', id: 'wiki' });
    expect($('say').textContent).toMatch(/duplicate/i);
  });

  it('says something rather than nothing when the address is blank', async () => {
    await mount();
    fill({ pattern: '' });
    expect($('say').textContent).toMatch(/address/i);
  });
});

describe('what it will not do', () => {
  it('has no way to save, and never writes anything', async () => {
    // The property the whole extension rests on. A store this add-on can write
    // is a store that drifts from its source and comes back after you delete it.
    await mount();
    // No control that writes. The word "save" appears in the instructions —
    // "save this as the file below" — which is the handover, not a button.
    const controls = [...document.querySelectorAll('button')].map((b) => b.id);
    expect(controls).toEqual(expect.arrayContaining(['add']));
    expect(controls.some((id) => /save|install|apply/i.test(id))).toBe(false);
    // storage is not even reachable from this page's stubs, so a write would throw
    expect(globalThis.chrome.storage).toBeUndefined();
  });

  it('names the file and tells you to reload, which is the whole handover', async () => {
    await mount();
    expect($('path').textContent).toContain('container-commander@sapn95.github.io');
    expect(document.body.textContent).toMatch(/Reload policy/);
  });

  it('emits the native-manifest wrapper, not a bare policy', async () => {
    // Pasting a bare policy into that path produces a file Firefox ignores
    // without saying so.
    await mount();
    const out = file();
    expect(out.type).toBe('storage');
    expect(out.name).toBe('container-commander@sapn95.github.io');
    expect(out.data.policy).toBeTruthy();
  });
});
