// The failure catalogue, as executable regressions.
//
// Every case here is something that actually happened on a real profile. A
// design change that lets one of them pass again is a regression whatever else
// it improves — so these are written as the situation that failed, not as the
// mechanism that fixes it. The mechanism is allowed to change; the outcome is not.
//
// See docs/failure-catalog.md for what each one cost.

import { describe, it, expect } from 'vitest';
import { decide } from '../src/lib/engine.js';
import { situation, insideBrowser, config, rule, WORK, ADMIN } from './helpers/situation.js';

const IDP = 'login.example-idp.com';
const CONSOLE = 'eu-central-1.console.example-cloud.com';

describe('F1 — the identity-provider yank', () => {
  // A sign-in that began in admin was pulled into work mid-redirect, and the
  // error shown was "your browser is set to block cookies", which points
  // nowhere near the cause.
  const pinned = config({
    authHosts: [IDP],
    rules: [rule({ id: 'idp', match: { host: IDP }, to: 'work' })],
  });

  it('never touches a sign-in hop, because the hop carries an origin', () => {
    const hop = situation({
      request: {
        url: `https://${IDP}/tenant/oauth2/authorize`,
        originUrl: 'https://apps.example.com/',
      },
      tab: { cookieStoreId: ADMIN },
      config: pinned,
    });
    expect(decide(hop).action).toBe('leave');
  });

  it('never touches it even when the flow began in another container', () => {
    const hop = situation({
      request: {
        url: `https://${IDP}/tenant/saml2`,
        originUrl: `https://${IDP}/tenant/oauth2/authorize`,
      },
      tab: { cookieStoreId: ADMIN },
      config: pinned,
    });
    const d = decide(hop);
    expect(d.action).toBe('leave');
    expect(d.cookieStoreId).toBeUndefined();
  });

  it('refuses a bare pin on an auth host even as a first navigation', () => {
    // Defence in depth: the compiler refuses this config, and if one is
    // hand-built anyway the engine still declines it.
    const entry = situation({
      request: { url: `https://${IDP}/tenant/authorize` },
      config: pinned,
    });
    expect(decide(entry).action).toBe('leave');
  });
});

describe('F2 — the confirm-page arms race', () => {
  it('leaves a tab a cooperating extension claimed, without asking anything', () => {
    const d = decide(
      situation({
        claims: { pendingMatch: { cookieStoreId: WORK, sender: 'linkward@sapn95.github.io' } },
        config: config({ rules: [rule({ scope: 'internal', to: 'ask' })] }),
      }),
    );
    expect(d.action).toBe('leave');
  });

  it('has no prompt at all on external entries', () => {
    const cfg = config({ rules: [rule({ scope: 'external', to: 'ask' })] });
    expect(decide(situation({ config: cfg })).action).not.toBe('ask');
  });

  it('does not enforce external rules while a peer reports a different revision', () => {
    // Two extensions running two revisions of one jurisdiction fact is F2 with
    // better manners.
    const cfg = config({
      revision: 'policy-b',
      peers: [{ id: 'linkward@sapn95.github.io', revision: 'policy-a' }],
      rules: [rule({ scope: 'external', to: 'work' })],
    });
    const d = decide(situation({ config: cfg }));
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/skew|revision|peer/i);
  });

  it('does enforce once the peers agree', () => {
    const cfg = config({
      revision: 'policy-b',
      peers: [{ id: 'linkward@sapn95.github.io', revision: 'policy-b' }],
      rules: [rule({ scope: 'external', to: 'work' })],
    });
    expect(decide(situation({ config: cfg })).action).toBe('reopen');
  });
});

describe('F4 — the host that cannot answer the question', () => {
  // Console accounts exist in work AND admin; the hostname carries the region,
  // not the account. A host rule dragged every admin launch into work.
  it('leaves a claimed console tab exactly where the launcher put it', () => {
    const d = decide(
      situation({
        request: { url: `https://${CONSOLE}/console/home` },
        claims: { pendingMatch: { cookieStoreId: ADMIN, sender: 'beeline@sapn95.github.io' } },
        config: config({ rules: [rule({ match: { host: CONSOLE }, to: 'work' })] }),
      }),
    );
    expect(d.action).toBe('leave');
  });

  it('does not route a console URL from a bookmark hint either', () => {
    // The same failure through the bookmarks tree, found by the adversarial pass.
    const d = decide(
      insideBrowser({
        request: { url: `https://${CONSOLE}/console/home` },
        bookmarkHits: [{ folderPath: 'toolbar/Work', container: 'work' }],
        config: config({
          never: [CONSOLE],
          bookmarks: {
            folders: [{ path: 'toolbar/Work', container: 'work' }],
            onConflict: 'leave',
          },
        }),
      }),
    );
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/never/i);
  });
});

describe('F6 — the federation endpoint that matched every application', () => {
  // A regex scoped to /saml2 was believed to match one VPN client. It is the
  // tenant's federation endpoint for EVERY application, so each launcher
  // opening was silently re-routed mid-flow — and the tab was closed and
  // reopened before first paint, leaving no trace.
  const samlRule = config({
    authHosts: [IDP],
    rules: [
      rule({
        id: 'vpn',
        scope: 'external',
        match: { regex: `^https://${IDP}/tenant/saml2` },
        to: 'work',
      }),
    ],
  });

  it('leaves the launcher flow alone: by then the hop carries an origin', () => {
    const hop = situation({
      request: {
        url: `https://${IDP}/tenant/saml2?SAMLRequest=x`,
        originUrl: 'https://launcher.example-apps.com/',
      },
      tab: { cookieStoreId: ADMIN },
      config: samlRule,
    });
    expect(decide(hop).action).toBe('leave');
  });

  it('leaves it alone when the launcher claimed the tab, before any rule is read', () => {
    const d = decide(
      situation({
        request: { url: `https://${IDP}/tenant/saml2?SAMLRequest=x` },
        claims: { pendingMatch: { cookieStoreId: ADMIN, sender: 'beeline@sapn95.github.io' } },
        config: samlRule,
      }),
    );
    expect(d).toMatchObject({ action: 'leave', rung: 1 });
  });

  it('still routes the genuine outside hand-off, which is what the rule is for', () => {
    const fromVpnClient = situation({
      request: { url: `https://${IDP}/tenant/saml2?SAMLRequest=x` },
      config: samlRule,
    });
    expect(decide(fromVpnClient)).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });
});

describe('the shape of silence', () => {
  it('reports which bookmark hint a rule overrode, so silence is auditable', () => {
    // Deterministic silence nobody can see is how F6 hid for two days.
    const d = decide(
      insideBrowser({
        bookmarkHits: [{ folderPath: 'toolbar/Personal', container: 'personal' }],
        config: config({
          rules: [rule({ scope: 'internal', to: 'work' })],
          bookmarks: {
            folders: [{ path: 'toolbar/Personal', container: 'personal' }],
            onConflict: 'leave',
          },
        }),
      }),
    );
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
    expect(d.suppressedHints).toEqual([{ folderPath: 'toolbar/Personal', container: 'personal' }]);
  });

  it('gives every decision a rung and a reason, including the boring ones', () => {
    const cases = [
      situation(),
      insideBrowser(),
      situation({ request: { method: 'POST' } }),
      situation({ request: { originUrl: 'https://a.example/' } }),
      situation({ config: null }),
    ];
    for (const s of cases) {
      const d = decide(s);
      expect(typeof d.rung).toBe('number');
      expect(typeof d.reason).toBe('string');
    }
  });
});
