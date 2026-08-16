// The defensive edges.
//
// All three modules run where a throw is expensive: the engine and the claim
// registry inside a blocking request listener, the loader behind it. "It cannot
// happen" is not a plan when the input crosses an extension boundary or comes
// off a file somebody edits by hand.

import { describe, it, expect } from 'vitest';
import { decide, hostMatches, entryShape, isInterceptable } from '../src/lib/engine.js';
import { createClaims } from '../src/lib/claims.js';
import { validateConfig, compile, loadConfig, SCHEMA } from '../src/lib/config.js';
import { situation, insideBrowser, config, rule } from './helpers/situation.js';

describe('the engine when the config is hostile rather than merely wrong', () => {
  it('treats a rule whose regex does not compile as one that never matches', () => {
    // The compiler refuses this. If one arrives anyway, an unmatched rule
    // leaves the tab alone, which is the safe direction.
    const cfg = config({ rules: [rule({ match: { regex: '([' } })] });
    expect(decide(situation({ config: cfg })).action).toBe('leave');
  });

  it('survives a rule with no match clause', () => {
    const cfg = config({ rules: [{ id: 'x', scope: 'external', to: 'work' }] });
    expect(decide(situation({ config: cfg })).action).toBe('leave');
  });

  it('survives rules that are not objects at all', () => {
    const cfg = config({ rules: [null, 42, 'nonsense'] });
    expect(() => decide(situation({ config: cfg }))).not.toThrow();
  });

  it('survives a rules key that is not an array', () => {
    expect(decide(situation({ config: config({ rules: 'all of them' }) })).action).toBe('leave');
  });

  it('survives a never list that is not a list', () => {
    expect(decide(situation({ config: config({ never: 'example.com' }) })).action).toBeTruthy();
  });

  it('survives containers being absent', () => {
    const cfg = config({ rules: [rule({ to: 'work' })] });
    expect(decide(situation({ config: cfg, containers: undefined })).action).toBe('leave');
  });

  it('matches a path-scoped rule only on that path', () => {
    const cfg = config({
      rules: [rule({ match: { host: 'example.com', path: '/deep' }, to: 'work' })],
    });
    const at = (url) => decide(situation({ request: { url }, config: cfg })).action;
    expect(at('https://example.com/deep/x')).toBe('reopen');
    expect(at('https://example.com/shallow')).toBe('leave');
  });
});

describe('the small pure helpers, at their edges', () => {
  it('matches a host and its subdomains, and tolerates a leading wildcard', () => {
    expect(hostMatches('mail.example.com', 'example.com')).toBe(true);
    expect(hostMatches('mail.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('', 'example.com')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
    expect(hostMatches('example.com', undefined)).toBe(false);
  });

  it('calls an unknown focus state external, never internal', () => {
    const shape = (focusedSince) =>
      entryShape({ focusedSince, at: 10_000, graceMs: 1500, marginMs: 1500 });
    expect(shape(undefined)).toBe('external');
    expect(shape(null)).toBe('external');
    expect(shape(NaN)).toBe('external');
    expect(shape('soon')).toBe('external');
  });

  it('rejects anything that is not an ordinary web page', () => {
    expect(isInterceptable('https://example.com/')).toBe(true);
    expect(isInterceptable('about:blank')).toBe(false);
    expect(isInterceptable('not a url')).toBe(false);
    expect(isInterceptable(undefined)).toBe(false);
  });
});

describe('the claim registry, handed nonsense', () => {
  const make = () => createClaims({ allow: ['beeline@sapn95.github.io'], ttlMs: 1000 });
  const SENDER = 'beeline@sapn95.github.io';

  it('refuses a claim with no cookieStoreId rather than inventing one', () => {
    const c = make();
    expect(c.claim({ url: 'https://example.com/', sender: SENDER })).toBe(false);
  });

  it('refuses a release from a stranger', () => {
    const c = make();
    c.claim({ url: 'https://example.com/', cookieStoreId: 'firefox-default', sender: SENDER }, 0);
    expect(c.release({ url: 'https://example.com/', sender: 'nobody@example.com' })).toBe(false);
  });

  it('survives a release for a url nothing claimed', () => {
    const c = make();
    expect(c.release({ url: 'https://example.com/', sender: SENDER })).toBe(false);
  });

  it('survives malformed releases and binds', () => {
    const c = make();
    for (const junk of [undefined, null, {}, { url: 7 }]) {
      expect(() => c.release(junk)).not.toThrow();
      expect(() => c.bind(junk)).not.toThrow();
    }
  });

  it('refuses to bind a tab for a stranger', () => {
    const c = make();
    expect(c.bind({ tabId: 1, sender: 'nobody@example.com' })).toBe(false);
    expect(c.isOurs(1)).toBe(false);
  });

  it('consumes nothing for a tab with neither url nor pendingUrl', () => {
    const c = make();
    c.claim({ url: 'https://example.com/', cookieStoreId: 'firefox-default', sender: SENDER }, 0);
    expect(c.consume({ id: 1 }, 10)).toBeNull();
  });

  it('marks the tab as ours the moment a claim is consumed', () => {
    const c = make();
    c.claim({ url: 'https://example.com/', cookieStoreId: 'firefox-default', sender: SENDER }, 0);
    c.consume({ id: 5, url: 'https://example.com/' }, 10);
    expect(c.isOurs(5)).toBe(true);
  });
});

describe('config validation, at its edges', () => {
  const base = { schema: SCHEMA, revision: 'r1', rules: [] };

  it('refuses anything that is not an object', () => {
    for (const junk of [undefined, null, 'config', 42]) {
      expect(validateConfig(junk).ok).toBe(false);
    }
  });

  it('refuses a config with no revision, because two machines must be comparable', () => {
    expect(validateConfig({ schema: SCHEMA, rules: [] }).ok).toBe(false);
  });

  it('refuses a rule with neither host nor regex', () => {
    const r = validateConfig({
      ...base,
      rules: [{ id: 'x', scope: 'internal', to: 'work', match: {} }],
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a rule that is not an object', () => {
    expect(validateConfig({ ...base, rules: [null] }).ok).toBe(false);
  });

  it('refuses a bookmark folder with no path', () => {
    const r = validateConfig({ ...base, bookmarks: { folders: [{ container: 'work' }] } });
    expect(r.ok).toBe(false);
  });

  it('refuses bookmarks.folders that is not an array', () => {
    expect(validateConfig({ ...base, bookmarks: { folders: 'toolbar' } }).ok).toBe(false);
  });

  it('accepts a path-scoped rule on an auth host', () => {
    const r = validateConfig({
      ...base,
      authHosts: ['login.example-idp.com'],
      rules: [
        {
          id: 'x',
          scope: 'external',
          to: 'work',
          match: { host: 'login.example-idp.com', path: '/tenant/saml2' },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('compiles nothing when validation failed', () => {
    expect(compile({ schema: 99 }).config).toBeNull();
  });

  it('fills in the defaults it is allowed to assume', () => {
    const { config: c } = compile(base);
    expect(c).toMatchObject({ dryRun: false, focusGraceMs: 1500, freshMs: 5000 });
    expect(c.internalMarginMs).toBe(1500);
  });

  it('takes the internal margin from the grace period when only one is given', () => {
    const { config: c } = compile({ ...base, focusGraceMs: 800 });
    expect(c.internalMarginMs).toBe(800);
  });
});

describe('loading, against a browser that is not cooperating', () => {
  it('goes inert when there is no managed API at all', async () => {
    await expect(loadConfig({})).resolves.toMatchObject({ inert: true });
  });

  it('goes inert when the manifest exists but holds nothing', async () => {
    const api = { storage: { managed: { get: async () => ({}) } } };
    await expect(loadConfig(api)).resolves.toMatchObject({ inert: true });
  });

  it('loads and compiles a good policy', async () => {
    const api = {
      storage: {
        managed: {
          get: async () => ({
            policy: {
              schema: SCHEMA,
              revision: 'r1',
              rules: [{ id: 'a', scope: 'external', to: 'work', match: { host: 'example.com' } }],
            },
          }),
        },
      },
    };
    const r = await loadConfig(api);
    expect(r.inert).toBe(false);
    expect(r.config.rules).toHaveLength(1);
  });
});

describe('a decision is always exactly one shape', () => {
  it('carries an action, a rung and a reason no matter what went in', () => {
    const cases = [
      situation(),
      insideBrowser(),
      situation({ config: null }),
      situation({ request: null }),
      situation({ candidate: { since: 'soon' } }),
      undefined,
    ];
    for (const s of cases) {
      const d = decide(s);
      expect(['leave', 'reopen', 'ask']).toContain(d.action);
      expect(Number.isFinite(d.rung)).toBe(true);
    }
  });
});
