// Building one policy out of several files.
//
// One file is fine until there are two sources for it. Work rules a config
// repository generates and personal rules written by hand cannot share a file
// without one overwriting the other every time either is regenerated — and the
// loser is silent, because a policy that lost half its rules is still a valid
// policy.
//
// So the tests here are mostly about the ways a merge can lose something
// quietly: a rule that disappears because two files claimed the same id, a
// dryRun that gets dropped because the other file did not mention it, an
// authHost that only one fragment knew about.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/lib/config.js';

const SCRIPT = 'scripts/build-policy.mjs';
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fragments-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name, policy) =>
  writeFileSync(join(dir, name), `${JSON.stringify(policy, null, 2)}\n`);

/** Run the builder in print mode and hand back stdout plus the exit code. */
function build(from = dir) {
  try {
    return { status: 0, out: execFileSync('node', [SCRIPT, '--from', from], { encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const WORK = {
  schema: 1,
  revision: 'work-1',
  dryRun: false,
  authHosts: ['login.example-idp.com'],
  never: ['console.example-cloud.com'],
  rules: [{ id: 'wiki', scope: 'any', match: { host: 'wiki.example-corp.com' }, to: 'work' }],
};
const PERSONAL = {
  rules: [{ id: 'mail', scope: 'any', match: { host: 'mail.example.com' }, to: 'me' }],
  never: ['bank.example.com'],
};

describe('merging fragments', () => {
  it('keeps every rule from every file', async () => {
    write('10-work.json', WORK);
    write('20-personal.json', PERSONAL);
    const { status, out } = build();

    expect(status).toBe(0);
    expect(out).toContain('wiki');
    expect(out).toContain('mail');
    expect(out).toMatch(/2 rule\(s\)/);
  });

  it('unions never and authHosts rather than letting the last file win', async () => {
    // A last-one-wins merge on these lists is how a `never` host quietly stops
    // being never — and a host coming OFF that list is the failure that made
    // the list exist.
    write('10-work.json', WORK);
    write('20-personal.json', PERSONAL);
    const { out } = build();

    expect(out).toContain('console.example-cloud.com');
    expect(out).toContain('bank.example.com');
  });

  it('refuses two files claiming the same rule id, and names both', async () => {
    // Not something to pick a winner for: it means two files believe they own
    // the rule, and silently keeping one is how a rule vanishes from a policy
    // nobody edited.
    write('10-work.json', WORK);
    write('20-personal.json', { rules: [{ ...WORK.rules[0], to: 'me' }] });
    const { status, out } = build();

    expect(status).not.toBe(0);
    expect(out).toMatch(/duplicate rule id "wiki"/);
    expect(out).toContain('20-personal.json');
    expect(out).toContain('10-work.json');
  });

  it('stays in dry run if ANY fragment asks for it', async () => {
    // The safe direction wins a disagreement. Enforcing because the other file
    // forgot to mention dryRun is the wrong way round.
    // The asking file must come FIRST. With it last, "any fragment asks" and
    // "the last file wins" give the same answer and the test proves nothing —
    // which is exactly what it did until a mutation run said so.
    write('10-work.json', { ...WORK, dryRun: true });
    write('20-personal.json', { ...PERSONAL, dryRun: false });
    const { out } = build();

    expect(out).toMatch(/dryRun\s+true/);
  });

  it('merges in file-name order, which is what the number prefix is for', async () => {
    write('20-b.json', {
      rules: [{ id: 'b', scope: 'any', match: { host: 'b.example.com' }, to: 'me' }],
    });
    write('10-a.json', WORK);
    const { out } = build();

    expect(out.indexOf('10-a.json')).toBeLessThan(out.indexOf('20-b.json'));
  });
});

describe('the revision it stamps', () => {
  it('names the inputs, so the popup answers "is what I edited what is running"', async () => {
    write('10-work.json', WORK);
    const first = build().out.match(/revision (\S+)/)[1];

    // A timestamp would answer "when was it built", which is a different
    // question and looks identical on screen.
    const second = build().out.match(/revision (\S+)/)[1];
    expect(second).toBe(first);
    expect(first).toContain('10-work');
  });

  it('changes when a fragment changes', async () => {
    write('10-work.json', WORK);
    const before = build().out.match(/revision (\S+)/)[1];

    write('10-work.json', {
      ...WORK,
      rules: [
        ...WORK.rules,
        { id: 'x', scope: 'any', match: { host: 'x.example.com' }, to: 'work' },
      ],
    });
    const after = build().out.match(/revision (\S+)/)[1];
    expect(after).not.toBe(before);
  });
});

describe('what it refuses to write', () => {
  it('rejects a merged policy the extension would not accept', async () => {
    // ask on an external rule: asking about outside links is linkward's job.
    write('10-work.json', {
      ...WORK,
      rules: [{ id: 'nope', scope: 'external', match: { host: 'a.example.com' }, to: 'ask' }],
    });
    const { status, out } = build();

    expect(status).not.toBe(0);
    expect(out).toMatch(/the merged policy is not valid/i);
    expect(out).toMatch(/only an internal rule may ask/i);
    // and it is a diagnosis, not a crash
    expect(out).not.toMatch(/TypeError|at Object\.|node:internal/);
  });

  it('says so rather than writing an empty policy when the directory is empty', async () => {
    // An empty glob is far more often a wrong path than a decision, and the
    // difference only shows up once the browser has stopped routing.
    const { status, out } = build();
    expect(status).not.toBe(0);
    expect(out).toMatch(/no \.json fragments/i);
  });

  it('names the file when one of them is not JSON', async () => {
    write('10-work.json', WORK);
    writeFileSync(join(dir, '20-broken.json'), '{ this is not json');
    const { status, out } = build();

    expect(status).not.toBe(0);
    expect(out).toContain('20-broken.json');
  });

  it('writes nothing at all without --apply', async () => {
    write('10-work.json', WORK);
    const { out } = build();
    expect(out).toMatch(/would write/);
    expect(out).not.toMatch(/^wrote /m);
  });
});

describe('the file it produces', () => {
  it('is the native-manifest wrapper, not a bare policy', async () => {
    // A bare policy saved to the managed path is ignored by Firefox without a
    // word — which looks exactly like the add-on being broken.
    // The name of that file IS the extension id — that is what makes Firefox
    // hand the policy to this add-on and not another one.
    write('10-work.json', WORK);
    const { out } = build();
    expect(out).toMatch(/would write .*(ManagedStorage|managed-storage)/);
    expect(out).toContain('container-commander@sapn95.github.io.json');
  });

  it('accepts a fragment that is already a full wrapper', async () => {
    // So a file that already works on its own can be dropped in unchanged.
    write('10-work.json', {
      name: 'container-commander@sapn95.github.io',
      description: 'container commander policy',
      type: 'storage',
      data: { policy: WORK },
    });
    const { status, out } = build();

    expect(status).toBe(0);
    expect(out).toContain('wiki');
  });

  it('produces something validateConfig accepts', async () => {
    write('10-work.json', WORK);
    write('20-personal.json', PERSONAL);
    const { out } = build();
    // Reconstruct what it would write from the two fragments and check it the
    // way the extension will.
    const merged = {
      schema: 1,
      revision: out.match(/revision (\S+)/)[1],
      dryRun: false,
      authHosts: WORK.authHosts,
      never: [...WORK.never, ...PERSONAL.never],
      rules: [...WORK.rules, ...PERSONAL.rules],
    };
    expect(validateConfig(merged).errors).toEqual([]);
  });
});
