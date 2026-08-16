// Config validation and compilation.
//
// This module is shared by the extension and by the config repo's compiler, so
// a config that compiles is a config the browser will accept — and a config the
// compiler refuses can never reach a browser. Several of the refusals below are
// the only thing standing between a tired evening edit and a repeat of the
// failure catalogue.

import { describe, it, expect } from 'vitest';
import { validateConfig, compile, SCHEMA } from '../src/lib/config.js';

const IDP = 'login.example-idp.com';

const base = {
  schema: SCHEMA,
  revision: 'policy-2026.01.01-abc1234',
  authHosts: [IDP],
  never: [],
  rules: [],
  bookmarks: { folders: [], onConflict: 'leave' },
};

const ok = (over = {}) => validateConfig({ ...base, ...over });

describe('what the compiler refuses to let through', () => {
  it('refuses a bare pin on an auth host', () => {
    // F1. The shared sign-in host has no correct fixed answer, so any fixed
    // answer is wrong two thirds of the time.
    const r = ok({ rules: [{ id: 'x', scope: 'external', match: { host: IDP }, to: 'work' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/auth host/i);
  });

  it('allows a path- or regex-scoped rule on an auth host', () => {
    // The VPN sign-in really does need routing; only the bare host pin is banned.
    const r = ok({
      rules: [
        {
          id: 'vpn',
          scope: 'external',
          match: { regex: `^https://${IDP}/tenant/saml2` },
          to: 'work',
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('refuses an external rule that asks', () => {
    // Prompting on outside links is linkward's monopoly. A convention is a
    // comment somebody edits past at 23:00; a refusal is not.
    const r = ok({
      rules: [{ id: 'x', scope: 'external', match: { host: 'example.com' }, to: 'ask' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/ask|external/i);
  });

  it('refuses a rule naming a host that a claim owns', () => {
    // F4: only the launcher knows which account an app is.
    const r = ok({
      claimedHosts: ['launcher.example-apps.com'],
      rules: [
        { id: 'x', scope: 'external', match: { host: 'launcher.example-apps.com' }, to: 'work' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/claim/i);
  });

  it('accepts an explicit scope of "any", which most host rules mean', () => {
    const r = ok({
      rules: [{ id: 'x', scope: 'any', match: { host: 'example.com' }, to: 'work' }],
    });
    expect(r.ok).toBe(true);
  });

  it('refuses an "any" rule that asks, because any includes outside links', () => {
    const r = ok({ rules: [{ id: 'x', scope: 'any', match: { host: 'example.com' }, to: 'ask' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/only an internal rule may ask/i);
  });

  it('refuses a rule with no scope, rather than guessing one', () => {
    const r = ok({ rules: [{ id: 'x', match: { host: 'example.com' }, to: 'work' }] });
    expect(r.ok).toBe(false);
  });

  it('refuses two rules with the same id', () => {
    const dup = { scope: 'internal', match: { host: 'example.com' }, to: 'work' };
    const r = ok({
      rules: [
        { id: 'x', ...dup },
        { id: 'x', ...dup },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a regex it cannot compile, at compile time rather than in the hot path', () => {
    const r = ok({ rules: [{ id: 'x', scope: 'external', match: { regex: '([' }, to: 'work' }] });
    expect(r.ok).toBe(false);
  });

  it('refuses a bookmark folder given by id instead of path', () => {
    // Bookmark ids are per profile: a config keyed by them only works on the
    // machine that wrote it, which is F5 in a different hat.
    const r = ok({
      bookmarks: { folders: [{ id: 'abc123', container: 'work' }], onConflict: 'leave' },
    });
    expect(r.ok).toBe(false);
  });

  it('names every problem it found, not just the first', () => {
    // A config edit round-trip that reveals one error at a time is how people
    // stop running the verifier.
    const r = ok({
      rules: [
        { id: 'a', scope: 'external', match: { host: IDP }, to: 'work' },
        { id: 'b', scope: 'external', match: { host: 'example.com' }, to: 'ask' },
      ],
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('schema versions', () => {
  it('checks the schema version first, before anything else can confuse it', () => {
    const r = validateConfig({ ...base, schema: 99, rules: [{ nonsense: true }] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/schema/i);
  });

  it('says which side is behind, rather than a generic error', () => {
    const newer = validateConfig({ ...base, schema: SCHEMA + 1 });
    expect(newer.errors.join(' ')).toMatch(/update the extension/i);
  });

  it('accepts the previous schema version, so an upgrade is not a flag day', () => {
    expect(validateConfig({ ...base, schema: SCHEMA - 1 }).ok).toBe(true);
  });
});

describe('compilation', () => {
  it('orders rules by specificity, so the engine never has to sort', () => {
    // Ordering is a property of the artefact: the order the verifier tests is
    // byte-identically the order the browser executes.
    const { config } = compile({
      ...base,
      rules: [
        { id: 'broad', scope: 'internal', match: { host: 'example.com' }, to: 'work' },
        { id: 'exact', scope: 'internal', match: { host: 'mail.example.com' }, to: 'admin' },
        {
          id: 'regex',
          scope: 'internal',
          match: { regex: '^https://example\\.com/x' },
          to: 'personal',
        },
      ],
    });
    expect(config.rules.map((r) => r.id)).toEqual(['regex', 'exact', 'broad']);
  });

  it('is deterministic: the same input compiles byte-identically', () => {
    const input = {
      ...base,
      rules: [{ id: 'a', scope: 'internal', match: { host: 'example.com' }, to: 'work' }],
    };
    expect(JSON.stringify(compile(input).config)).toBe(JSON.stringify(compile(input).config));
  });

  it('carries the revision through, because two machines must be comparable', () => {
    const { config } = compile({ ...base, revision: 'policy-x-dirty' });
    expect(config.revision).toBe('policy-x-dirty');
  });
});

describe('loading, when the platform will not cooperate', () => {
  it('treats a missing managed manifest as a fresh install, not a failure', async () => {
    // storage.managed.get() REJECTS when no native manifest exists.
    const { loadConfig } = await import('../src/lib/config.js');
    const chrome = {
      storage: {
        managed: {
          get: async () => {
            throw new Error('Managed storage manifest not found');
          },
        },
      },
    };
    await expect(loadConfig(chrome)).resolves.toMatchObject({ config: null, inert: true });
  });

  it('goes inert rather than throwing when the config is invalid', async () => {
    const { loadConfig } = await import('../src/lib/config.js');
    const chrome = { storage: { managed: { get: async () => ({ policy: { schema: 99 } }) } } };
    const r = await loadConfig(chrome);
    expect(r.inert).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
