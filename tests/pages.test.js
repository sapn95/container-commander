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
      getCurrent: vi.fn(async () => ({ id: 5, active: true, windowId: 3, index: 4 })),
      // As strict as the browser about the two fields that are easy to compute
      // into nonsense: tabs.create rejects a non-integer index or windowId, and
      // the catch around it would turn that into a picker that silently eats
      // every choice made on it.
      create: vi.fn(async (props = {}) => {
        for (const k of ['index', 'windowId']) {
          if (k in props && !Number.isInteger(props[k])) throw new Error(`bad ${k}`);
        }
        return { id: 9 };
      }),
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
const labels = () => buttons().map((b) => b.lastChild.textContent);

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('the picker', () => {
  it('puts the replacement where the tab it replaces stood', async () => {
    // A14, and this page is the one the rule redirected — so its window and its
    // position are the ones worth keeping. Same fix as the override path, made
    // at the same time, because A14 being true in one of the two places it
    // applies is how a claim in the docs quietly stops being a claim.
    await mountPicker('?url=https://example.com/');
    buttons()[0].click();
    await settle();
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, windowId: 3, index: 5 }),
    );
  });

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
  // cc:pause is modelled rather than stubbed flat. The background page holds
  // the paused flag and answers with what it now is, and a double that always
  // replied with the mount-time status would agree with a Resume button that
  // resumes nothing — which is exactly the bug this shape caught.
  async function mountPopup(status, peers = null, { pauseAnswers = true, others = null } = {}) {
    let paused = status?.paused === true;
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        sendMessage: vi.fn(async (m) => {
          if (m?.type === 'cc:others') return others;
          if (m?.type === 'cc:peers') return peers;
          if (m?.type === 'cc:pause') {
            if (!pauseAnswers) throw new Error('no receiving end');
            paused = m.paused === true;
            return { paused };
          }
          return status;
        }),
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

  // The list answered "what was decided" and never "where did the tab end up",
  // so the question people arrive with could only be answered by knowing the
  // ladder by heart. The reason was in a tooltip, which is to say nowhere.
  it('says where the tab went, and shows the reason without a hover', async () => {
    await mountPopup({
      ...loaded,
      log: [
        {
          at: 1,
          url: 'https://example.com/x',
          decision: { action: 'reopen', rung: 4, reason: 'rule:corp-wide' },
          from: 'No container',
          to: 'work',
        },
      ],
    });
    const why = document.querySelector('#log li .why').textContent;
    expect(why).toContain('No container → work');
    expect(why).toContain('rule:corp-wide');
  });

  it('does not draw an arrow when the tab did not move', async () => {
    await mountPopup({
      ...loaded,
      log: [
        {
          at: 1,
          url: 'https://example.com/x',
          decision: { action: 'leave', rung: 2, reason: 'user-container-entry' },
          from: 'work',
          to: 'work',
        },
      ],
    });
    const why = document.querySelector('#log li .why').textContent;
    expect(why).toContain('work · user-container-entry');
    expect(why).not.toContain('→');
  });

  it('spells out a reopen the browser did not complete', async () => {
    // `left-over` on its own answers nothing to somebody asking why a tab is in
    // the wrong place, and two tabs on one address is the symptom this whole
    // extension exists to remove.
    await mountPopup({
      ...loaded,
      log: [
        {
          at: 1,
          url: 'https://example.com/x',
          decision: { action: 'reopen', rung: 4, reason: 'rule:corp-wide' },
          from: 'No container',
          to: 'work',
          outcome: 'left-over',
        },
      ],
    });
    expect(document.querySelector('#log li .why').textContent).toContain('both are open');
  });

  it('prints no arrow to nowhere for an entry logged before this existed', async () => {
    // The log survives an extension reload, so older entries have neither
    // field. A bare arrow for them would read as a move that never happened.
    await mountPopup({
      ...loaded,
      log: [
        {
          at: 1,
          url: 'https://example.com/x',
          decision: { action: 'leave', rung: 6, reason: 'no-match' },
        },
      ],
    });
    const why = document.querySelector('#log li .why').textContent;
    expect(why).toBe('no-match');
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

  // Two extensions both holding a blocking webRequest listener both cancel the
  // same request and both open a replacement, and Firefox carries out both. The
  // rules on this page are then entirely accurate about where a host belongs,
  // and the browser still opens two tabs for it — which is why this section sits
  // above the policy rather than next to it.
  const CLASH = {
    clash: [
      {
        id: 'linkward@sapn95.github.io',
        name: 'linkward',
        version: '0.1.0',
        routes: ['docs.example.com', 'code.example.com'],
        overlap: ['docs.example.com'],
      },
    ],
    line: 'linkward 0.1.0 is also routing navigation. Both route docs.example.com.',
  };

  it('stays out of the way when nothing else is routing', async () => {
    await mountPopup(loaded, { clash: [], line: null });
    expect($('clash').hidden).toBe(true);
  });

  it('names the other extension and the hosts they both claim', async () => {
    await mountPopup(loaded, CLASH);
    expect($('clash').hidden).toBe(false);
    expect($('clash-line').textContent).toContain('linkward 0.1.0');
    const row = document.querySelector('#clash-list li');
    expect(row.textContent).toContain('linkward 0.1.0');
    expect(row.textContent).toContain('docs.example.com');
    // The overlap, not the peer's whole rule list: the shared hosts are the tabs
    // arriving in pairs, and they are what to search the other add-on for.
    expect(row.textContent).not.toContain('code.example.com');
  });

  it('falls back to the peer whole route list when nothing compares', async () => {
    // A regex rule is published as an id on either side, so two extensions can
    // collide on a host neither of them named in a comparable way. Showing the
    // peer's list beats showing an empty bullet.
    await mountPopup(loaded, {
      clash: [{ ...CLASH.clash[0], overlap: [], routes: ['rule:msal'] }],
      line: 'linkward 0.1.0 is also routing navigation.',
    });
    expect(document.querySelector('#clash-list li').textContent).toContain('rule:msal');
  });

  it('does not break the page when the background cannot answer', async () => {
    await mountPopup(loaded, null);
    expect($('clash').hidden).toBe(true);
    expect($('revision').textContent).toBe('policy-abc');
  });

  // Multi-Account Containers ran beside this add-on for weeks: a blocking
  // listener, a list of site assignments, no protocol, invisible to every check
  // either side could run. This section is the only thing that can see one.
  describe('add-ons that route and never answer', () => {
    const MAC = {
      id: '@testpilot-containers',
      name: 'Firefox Multi-Account Containers',
      version: '8.3.8',
      why: ['opens tabs in containers', 'can take a request before it is sent'],
    };

    it('names it and says what it declared it can do', async () => {
      await mountPopup(
        loaded,
        { clash: [], line: null },
        { others: { granted: true, others: [MAC] } },
      );
      expect($('others').hidden).toBe(false);
      expect($('others-line').textContent).toContain('Firefox Multi-Account Containers 8.3.8');
      const row = document.querySelector('#others-list li');
      expect(row.textContent).toContain('opens tabs in containers');
      expect($('others-ask').hidden).toBe(true);
    });

    it('counts them when there are several', async () => {
      await mountPopup(
        loaded,
        { clash: [], line: null },
        { others: { granted: true, others: [MAC, { ...MAC, id: 'b@x', name: 'Other' }] } },
      );
      expect($('others-line').textContent).toMatch(/^2 add-ons/);
    });

    it('stays out of the way when nothing else can route', async () => {
      await mountPopup(
        loaded,
        { clash: [], line: null },
        { others: { granted: true, others: [] } },
      );
      expect($('others').hidden).toBe(true);
      expect($('others-ask').hidden).toBe(true);
    });

    it('offers the grant rather than showing an empty result', async () => {
      // An empty list without the permission would read as a clean census. The
      // honest answer is that the question has not been asked.
      await mountPopup(
        loaded,
        { clash: [], line: null },
        { others: { granted: false, others: [] } },
      );
      expect($('others-ask').hidden).toBe(false);
      expect($('others').hidden).toBe(true);
    });

    it('offers the grant when the background cannot answer at all', async () => {
      await mountPopup(loaded, { clash: [], line: null }, { others: null });
      expect($('others-ask').hidden).toBe(false);
    });
  });

  // The warning named the problem and left the reader to go and fix it by hand
  // in an add-on this one cannot see. These are the two halves it can offer
  // instead: the decision it is in a position to carry out, and the paste-ready
  // text for the one it is not.
  it('stands down on one click, and says so in the past tense', async () => {
    await mountPopup(loaded, CLASH);
    $('clash-standdown').click();
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'cc:pause', paused: true });
    expect($('clash-standdown').disabled).toBe(true);
    expect($('clash-standdown').textContent).toMatch(/stopped/i);
    // Session-scoped, and the note has to keep saying so: a fix that quietly
    // expires at the next restart is how this bug got its second life.
    expect($('clash-standdown-note').textContent).toMatch(/until Firefox restarts/i);
    // And the Pause button below is now the same fact, not the opposite one.
    expect($('pause').textContent).toBe('Resume');
  });

  it('puts the offer back when nothing was actually paused', async () => {
    // A disabled button reads as done. Reporting a fix nobody applied is the
    // one outcome worse than the warning it replaced.
    await mountPopup(loaded, CLASH, { pauseAnswers: false });
    $('clash-standdown').click();
    await settle();
    expect($('clash-standdown').disabled).toBe(false);
    expect($('clash-standdown-note').textContent).toMatch(/nothing was paused/i);
  });

  it('offers the stand-down again when routing is resumed from Policy', async () => {
    // Found in review. The two directions were written separately and the way
    // back was missing, so Resume below started routing again while this block
    // still read "Routing stopped here", disabled, over a browser that was.
    await mountPopup(loaded, CLASH);
    $('clash-standdown').click();
    await settle();
    expect($('clash-standdown').disabled).toBe(true);

    $('pause').click();
    await settle();
    expect($('pause').textContent).toBe('Pause for this session');
    expect($('clash-standdown').disabled).toBe(false);
    expect($('clash-standdown').textContent).toBe('Stop routing here');
    expect($('clash-standdown-note').textContent).toMatch(/Pauses container commander/);
  });

  it('drops the alarm once the other add-on has given way', async () => {
    // The whole point of the hand-over, and it was invisible: linkward released
    // every host this policy publishes and the popup went on demanding that
    // somebody switch one of the two off.
    await mountPopup(loaded, {
      clash: [{ ...CLASH.clash[0], overlap: [], standingDown: true }],
      line: 'linkward 0.8.0 is also routing navigation, and gives way on the hosts this policy publishes.',
    });
    const box = $('clash');
    expect(box.hidden).toBe(false);
    expect(box.classList.contains('state')).toBe(false);
    expect(box.classList.contains('settled')).toBe(true);
    expect(document.querySelector('#clash h2').textContent).toBe(
      'linkward is giving way to this add-on',
    );
    // The stop is still offered, just not as the thing to do.
    expect($('clash-standdown').classList.contains('primary')).toBe(false);
  });

  it('does not name one peer when several have given way', async () => {
    // Two add-ons speak this protocol today and the list is meant to grow. A
    // heading naming one by hand goes wrong the first time it is the other.
    await mountPopup(loaded, {
      clash: [
        { ...CLASH.clash[0], overlap: [], standingDown: true },
        { ...CLASH.clash[0], name: 'beeline', overlap: [], standingDown: true },
      ],
      line: 'linkward 0.8.0 (and 1 more) is also routing navigation, and gives way.',
    });
    const heading = document.querySelector('#clash h2').textContent;
    expect(heading).toBe('The other add-ons are giving way to this one');
    expect(heading).not.toMatch(/linkward/);
  });

  it('keeps the alarm while the other add-on is still routing against it', async () => {
    await mountPopup(loaded, CLASH);
    const box = $('clash');
    expect(box.classList.contains('state')).toBe(true);
    expect(box.classList.contains('settled')).toBe(false);
    expect($('clash-standdown').classList.contains('primary')).toBe(true);
  });

  it('does not claim the links are opening twice, because they may not be', async () => {
    // A routing peer is reported whether or not anything overlaps — linkward
    // with no rules still redirects to its picker — and since linkward began
    // standing down on the shared hosts, an empty overlap is the ordinary case.
    // A heading that named the symptom was wrong exactly when the fix worked.
    await mountPopup(loaded, CLASH);
    const heading = document.querySelector('#clash h2').textContent;
    expect(heading).toMatch(/routing/i);
    expect(heading).not.toMatch(/twice/i);
  });

  it('opens already standing down when the session is paused', async () => {
    await mountPopup({ ...loaded, paused: true }, CLASH);
    expect($('clash-standdown').disabled).toBe(true);
    expect($('clash-standdown').textContent).toMatch(/stopped/i);
  });

  it('offers the shared hosts as a never list that the policy would accept', async () => {
    await mountPopup(loaded, CLASH);
    const never = JSON.parse($('clash-never').textContent);
    expect(never).toEqual({ never: ['docs.example.com'] });
    // It goes into a file the validator reads, so it has to survive that too.
    expect(validateConfig({ schema: 1, revision: 'r', rules: [], ...never }).ok).toBe(true);
  });

  it('says there is nothing to name rather than printing an empty never list', async () => {
    await mountPopup(loaded, {
      clash: [{ ...CLASH.clash[0], overlap: [], routes: ['rule:msal'] }],
      line: 'linkward 0.1.0 is also routing navigation.',
    });
    expect($('clash-never').textContent).toMatch(/nothing to name/i);
    expect($('clash-never').textContent).not.toContain('rule:msal');
  });

  // Not part of the clash work, found by it: the handler toggled against the
  // reply to a message sent once when the page opened, so it sent paused:true
  // on the first click and paused:true again on the second. Pause worked; the
  // Resume it turned into did nothing at all.
  it('resumes on the second click instead of pausing twice', async () => {
    await mountPopup(loaded);
    $('pause').click();
    await settle();
    expect($('pause').textContent).toBe('Resume');
    $('pause').click();
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      type: 'cc:pause',
      paused: false,
    });
    expect($('pause').textContent).toBe('Pause for this session');
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
        getURL: (path) => `moz-extension://cc/${path}`,
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
        getURL: (path) => `moz-extension://cc/${path}`,
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

describe('the rules, which the popup used to report as a number', () => {
  // "I cannot get at the rules, or look at them, or edit them" — and he was
  // right: the page said "11 rule(s)" and stopped. Worth the space for a reason
  // that is not obvious from the file either: compile() re-orders rules by
  // specificity, so what is shown here is the evaluation order and it is NOT
  // the order they sit in the source. There is nowhere else to see it.

  const POLICY = {
    revision: 'r1',
    dryRun: true,
    rules: [
      {
        id: 'idp',
        scope: 'external',
        match: { regex: '^https://login\\.example-idp\\.com/' },
        to: 'work',
      },
      { id: 'wiki', scope: 'any', match: { host: 'wiki.example.com' }, to: 'work' },
      { id: 'shared', scope: 'internal', match: { host: 'shared.example.com' }, to: 'ask' },
    ],
    never: ['console.example-cloud.com'],
    authHosts: ['login.example-idp.com'],
    bookmarks: { folders: [{ path: 'Toolbar/Work', to: 'work' }] },
  };

  async function mount(config) {
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.location = { reload: vi.fn(), href: 'moz-extension://cc/popup/popup.html' };
    globalThis.chrome = {
      runtime: {
        id: 'container-commander@sapn95.github.io',
        getURL: (path) => `moz-extension://cc/${path}`,
        getManifest: () => ({ version: '9.9.9' }),
        reload: vi.fn(),
        sendMessage: vi.fn(async () => ({
          inert: false,
          errors: [],
          paused: false,
          log: [],
          config,
        })),
      },
      permissions: { contains: async () => true, request: vi.fn() },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();
  }

  const rows = () => [...document.querySelectorAll('#rulelist li')].map((li) => li.textContent);

  it('lists every rule, in the order they are evaluated', async () => {
    await mount(POLICY);
    expect($('rules-section').hidden).toBe(false);
    const text = rows();
    expect(text).toHaveLength(3);
    expect(text[0]).toContain('login');
    expect(text[1]).toContain('wiki.example.com');
  });

  it('says where each one sends a tab, and marks the ones that ask', async () => {
    await mount(POLICY);
    expect(rows()[1]).toMatch(/→\s*work/);
    expect(rows()[2]).toMatch(/→\s*ask/);
    expect(document.querySelector('#rulelist .ask')).not.toBeNull();
  });

  it('carries the scope and the id, because that is what the log refers to', async () => {
    await mount(POLICY);
    expect(rows()[0]).toContain('external');
    expect(rows()[0]).toContain('idp');
  });

  it('shows never and auth hosts too, which decide outcomes just as much', async () => {
    // Leaving them off would make the rule list look like the whole policy.
    await mount(POLICY);
    const lists = $('lists').textContent;
    expect(lists).toContain('console.example-cloud.com');
    expect(lists).toContain('login.example-idp.com');
    expect(lists).toContain('Toolbar/Work');
  });

  it('renders a rule as text and never as markup', async () => {
    // A rule is a string out of a file this page did not write.
    await mount({
      ...POLICY,
      rules: [
        { id: 'x', scope: 'any', match: { host: '<img src=x onerror=alert(1)>' }, to: 'work' },
      ],
    });
    expect(document.querySelector('#rulelist img')).toBeNull();
    expect(rows()[0]).toContain('<img');
  });

  it('names the file to edit, since the add-on cannot write it', async () => {
    await mount(POLICY);
    expect($('rules-path').textContent).toContain('container-commander@sapn95.github.io');
  });

  it('stays hidden when there is no policy at all', async () => {
    document.documentElement.innerHTML = html('src/popup/popup.html');
    globalThis.location = { reload: vi.fn(), href: 'x' };
    globalThis.chrome = {
      runtime: {
        id: 'x@y',
        getManifest: () => ({ version: '9' }),
        reload: vi.fn(),
        sendMessage: vi.fn(async () => NO_POLICY),
      },
      permissions: { contains: async () => true, request: vi.fn() },
    };
    vi.resetModules();
    await import('../src/popup/popup.js');
    await settle();
    expect($('rules-section').hidden).toBe(true);
  });

  it('survives a policy with no never list and no bookmarks', async () => {
    await mount({ revision: 'r', dryRun: false, rules: [] });
    expect($('rules-section').hidden).toBe(false);
    expect(rows()).toEqual([]);
  });
});

describe('the toolbar panel', () => {
  // The override was reachable, in the sense that a right-click on a tab strip
  // is reachable. It is now the toolbar button, which is the difference between
  // shipped and usable. What this file guards is that the panel never offers a
  // move that costs something and buys nothing.

  // Firefox dismissing or refusing the permission prompt, which is a different
  // outcome from never having asked and has its own branch in the panel.
  let chromeRefuses = false;

  const WORK = { name: 'work', cookieStoreId: 'firefox-container-2', colorCode: '#f00' };
  const HOME = { name: 'personal', cookieStoreId: 'firefox-container-1', colorCode: '#0f0' };

  async function mountPanel({
    tab,
    containers = [WORK, HOME],
    granted = true,
    peers = null,
    pauseAnswers = true,
  } = {}) {
    document.documentElement.innerHTML = html('src/switch/switch.html');
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn(async (m) => {
          if (m?.type === 'cc:peers') return peers;
          // Modelled, not flattened to { moved: true }: the panel treats the
          // reply as the authority on whether anything was actually paused, so
          // a double that answers yes to every message would let a broken
          // stand-down report success.
          if (m?.type === 'cc:pause') {
            if (!pauseAnswers) throw new Error('no receiving end');
            return { paused: m.paused === true };
          }
          return { moved: true };
        }),
        openOptionsPage: vi.fn(async () => {}),
      },
      tabs: { query: vi.fn(async () => (tab ? [tab] : [])) },
      // An optional permission that was never granted: the namespace is there,
      // the answer is false. Modelling it as absent is a different bug.
      permissions: {
        contains: vi.fn(async () => granted),
        request: vi.fn(async () => !chromeRefuses),
      },
    };
    globalThis.browser = { contextualIdentities: { query: async () => containers } };
    window.close = vi.fn();
    // jsdom refuses a real navigation, and the grant path reloads the panel to
    // rebuild it against the permission it has just been given.
    globalThis.location = { href: 'moz-extension://cc/switch/switch.html', reload: vi.fn() };
    vi.resetModules();
    await import('../src/switch/switch.js');
    await settle();
  }

  const press = (key) =>
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key, cancelable: true }));

  const inWork = {
    id: 7,
    url: 'https://code.example.com/dash',
    cookieStoreId: 'firefox-container-2',
  };

  it('names where the tab is now, and does not offer to put it back there', async () => {
    // The whole cost of a move is a lost history and a lost scroll position. A
    // move to the container the tab is already in pays that for nothing, so the
    // current container is stated as a fact rather than drawn as a choice.
    await mountPanel({ tab: inWork });
    expect($('here-name').textContent).toBe('work');
    expect(labels()).toEqual(['personal', 'No container']);
  });

  it('offers no way out of a container the tab is not in', async () => {
    // "No container" IS the current container here, so by the same rule it is
    // not a destination.
    await mountPanel({ tab: { ...inWork, cookieStoreId: 'firefox-default' } });
    expect($('here-name').textContent).toBe('No container');
    expect(labels()).toEqual(['work', 'personal']);
  });

  it('shows the host as text, never as a link', async () => {
    // Same posture as the picker. This one is not web-accessible, but the string
    // still came off a page somebody visited, and the rule is cheaper to keep
    // than to reason about per page.
    await mountPanel({ tab: inWork });
    expect($('host').textContent).toBe('code.example.com');
    expect($('host').querySelector('a')).toBeNull();
  });

  it('says there is nothing to move on a page that has no container', async () => {
    await mountPanel({ tab: { id: 7, url: 'about:config', cookieStoreId: 'firefox-default' } });
    expect($('nothing').hidden).toBe(false);
    expect($('move').hidden).toBe(true);
  });

  it('hands the move to the background, with both ends of it named', async () => {
    // Not tabs.create here: openThere() announces the move to linkward before
    // the tab exists and writes the OVERRIDE line into the log, and a second
    // copy of that sequence is the copy that goes stale.
    await mountPanel({ tab: inWork });
    buttons()[0].click();
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'cc:override',
      tabId: 7,
      url: 'https://code.example.com/dash',
      from: 'firefox-container-2',
      to: 'firefox-container-1',
    });
    expect(window.close).toHaveBeenCalled();
  });

  it('still moves tabs on a profile that never granted the watching permission', async () => {
    // The point of using activeTab. Automatic routing is off without the grant;
    // moving a tab by hand needs no host permission at all, and putting the one
    // control this panel has behind a grant it does not need would be this
    // extension's signature failure with a new coat on.
    await mountPanel({ tab: inWork, granted: false });
    expect($('warn').hidden).toBe(false);
    expect($('move').hidden).toBe(false);
    expect(labels()).toEqual(['personal', 'No container']);
  });

  it('keeps quiet about the grant once it has it', async () => {
    await mountPanel({ tab: inWork, granted: true });
    expect($('warn').hidden).toBe(true);
  });

  it('rebuilds itself once the grant is given, rather than lying until reopened', async () => {
    await mountPanel({ tab: inWork, granted: false });
    $('grant-button').click();
    await settle();
    expect(chrome.permissions.request).toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalled();
  });

  it('stops offering a grant Firefox has just refused', async () => {
    // Leaving the button live invites a second dismissal, and a permission
    // prompt dismissed twice is one Firefox stops showing.
    chromeRefuses = true;
    await mountPanel({ tab: inWork, granted: false });
    $('grant-button').click();
    await settle();
    expect($('grant-button').disabled).toBe(true);
    expect(location.reload).not.toHaveBeenCalled();
    chromeRefuses = false;
  });

  it('takes 1-9 for the choices, as the picker does', async () => {
    await mountPanel({ tab: inWork });
    press('2');
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ to: '' }));
  });

  it('leaves the browser its own modified keys', async () => {
    // Taking Cmd-C from somebody copying the host off this panel would be its
    // own small betrayal.
    await mountPanel({ tab: inWork });
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: '1', metaKey: true, cancelable: true }),
    );
    await settle();
    // No MOVE, rather than no message at all: the panel asks the background who
    // else is routing as it opens, so "nothing was sent" stopped being the way
    // to say "nothing was done".
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cc:override' }),
    );
  });

  it('opens the settings page and gets out of the way', async () => {
    await mountPanel({ tab: inWork });
    $('settings').click();
    await settle();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
    expect(window.close).toHaveBeenCalled();
  });

  it('says nothing to move when there is no tab to read at all', async () => {
    // tabs.query rejecting, or answering with nothing: a window closing under
    // the panel, or a profile where the click did not grant activeTab.
    await mountPanel({ tab: null });
    expect($('nothing').hidden).toBe(false);
    expect($('move').hidden).toBe(true);
  });

  it('says when another extension is routing the same hosts', async () => {
    await mountPanel({ tab: inWork, peers: { clash: [{}], line: 'linkward is also routing.' } });
    expect($('clash').hidden).toBe(false);
    expect($('clash-line').textContent).toBe('linkward is also routing.');
  });

  it('hands the tabs over on one click, from the panel as from the popup', async () => {
    await mountPanel({
      tab: inWork,
      peers: { clash: [{}], line: 'linkward is also routing.' },
    });
    $('clash-standdown').click();
    await settle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'cc:pause', paused: true });
    expect($('clash-standdown').textContent).toMatch(/stopped/i);
    expect($('clash-standdown-note').textContent).toMatch(/until Firefox restarts/i);
  });

  it('offers the stand-down again when nothing was paused', async () => {
    await mountPanel({
      tab: inWork,
      peers: { clash: [{}], line: 'linkward is also routing.' },
      pauseAnswers: false,
    });
    $('clash-standdown').click();
    await settle();
    expect($('clash-standdown').disabled).toBe(false);
    expect($('clash-standdown-note').textContent).toMatch(/nothing was paused/i);
  });

  it('keeps the clash a strip and never a state', async () => {
    // Moving a tab by hand works perfectly while two extensions fight over the
    // automatic case. Hiding the one control on this panel behind that warning
    // would be this extension's signature failure with a new coat on.
    await mountPanel({ tab: inWork, peers: { clash: [{}], line: 'linkward is also routing.' } });
    expect($('move').hidden).toBe(false);
    expect(buttons().length).toBeGreaterThan(0);
  });

  it('draws the panel even if the census never comes back', async () => {
    // It asks two other extensions and one of them may be asleep. The thing this
    // popup is FOR must not wait on that.
    await mountPanel({ tab: inWork, peers: null });
    expect($('move').hidden).toBe(false);
    expect($('clash').hidden).toBe(true);
  });
});
