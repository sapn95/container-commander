// The ladder: claims, inheritance, entry shape, rules, ask, leave.
//
// The order of the rungs IS the design, so it is tested as an order and not
// only as a set of behaviours: each rung is shown to beat the one below it in a
// situation where they disagree.

import { describe, it, expect } from 'vitest';
import { decide } from '../src/lib/engine.js';
import {
  situation,
  insideBrowser,
  config,
  rule,
  WORK,
  ADMIN,
  DEFAULT_STORE,
  NOW,
  GRACE,
} from './helpers/situation.js';

describe('RUNG 1 — claims outrank everything', () => {
  const claimed = { pendingMatch: { cookieStoreId: ADMIN, sender: 'beeline@sapn95.github.io' } };

  it('hands the tab off to the claiming extension', () => {
    const d = decide(situation({ claims: claimed }));
    expect(d).toMatchObject({ action: 'leave', rung: 1 });
  });

  it('beats a deterministic rule that names the same host', () => {
    // F4: the launcher is the only party that knows WHICH account an app is.
    // A host rule is a guess made earlier by someone who could not see this.
    const d = decide(
      situation({
        claims: claimed,
        config: config({ rules: [rule({ to: 'work' })] }),
      }),
    );
    expect(d.action).toBe('leave');
  });

  it('keeps a tab hands-off for its whole life, not only its first request', () => {
    const d = decide(
      situation({
        claims: { boundToTab: true },
        candidate: { spent: true },
        config: config({ rules: [rule({ to: 'work' })] }),
      }),
    );
    expect(d).toMatchObject({ action: 'leave', rung: 1 });
  });

  it('degrades a lost claim to leave-alone, never to a rule', () => {
    // If the claim was lost the launcher has already placed the tab. Second-
    // guessing it is F4 again.
    const expired = situation({
      claims: { pendingMatch: null },
      config: config({ rules: [rule({ to: 'work' })] }),
      // an external-shaped entry the launcher actually opened
      focus: { focusedSince: NOW - 60_000 },
    });
    expect(decide(expired).action).toBe('leave');
  });
});

describe('RUNG 2 — inheritance, which IS "auth follows caller"', () => {
  it.each([
    ['originUrl', { originUrl: 'https://portal.example.com/' }],
    ['documentUrl', { documentUrl: 'https://portal.example.com/' }],
  ])('leaves a navigation a document started (%s)', (_name, request) => {
    // F1: every hop of every sign-in flow after the first carries one of these,
    // so no rule ever sees a redirect. The rule that cannot fire cannot be wrong.
    const d = decide(
      situation({
        request,
        config: config({ rules: [rule({ match: { host: 'example.com' }, to: 'work' })] }),
      }),
    );
    expect(d).toMatchObject({ action: 'leave', rung: 2 });
  });

  it('leaves a tab that a page opened', () => {
    const d = decide(
      situation({
        tab: { openerTabId: 3 },
        config: config({ rules: [rule({ to: 'work' })] }),
      }),
    );
    expect(d).toMatchObject({ action: 'leave', rung: 2 });
  });

  it('does not read config at all before deciding to inherit', () => {
    // Defence in depth: even a config that would crash a rule matcher must not
    // be able to affect an inherited flow.
    const d = decide(
      situation({
        request: { originUrl: 'https://portal.example.com/' },
        config: config({ rules: [{ id: 'broken' }] }),
      }),
    );
    expect(d.action).toBe('leave');
  });

  it('treats a container the user chose by hand as provenance', () => {
    // "New Container Tab -> admin", then type an address. The strongest signal
    // the platform offers: a person said so, in this tab, just now.
    const d = decide(
      insideBrowser({
        tab: { cookieStoreId: ADMIN },
        config: config({ rules: [rule({ scope: 'internal', to: 'work' })] }),
      }),
    );
    expect(d).toMatchObject({ action: 'leave', rung: 2 });
  });

  it('still applies rules in a plain uncontained tab, which is what they are for', () => {
    const d = decide(
      insideBrowser({
        tab: { cookieStoreId: DEFAULT_STORE },
        config: config({ rules: [rule({ scope: 'internal', to: 'work' })] }),
      }),
    );
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });
});

describe('RUNG 3 — entry shape, and the band where nobody acts', () => {
  const ext = config({ rules: [rule({ scope: 'external', to: 'work' })] });
  const int = config({ rules: [rule({ scope: 'internal', to: 'work' })] });

  it('calls a tab external-shaped when the browser had just come to the front', () => {
    const d = decide(situation({ focus: { focusedSince: NOW - 100 }, config: ext }));
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });

  it('calls it internal-shaped only past TWICE the grace period', () => {
    // linkward and commander both classify entries. If they disagree at the
    // boundary, both may act — so commander needs the wider margin.
    const d = decide(insideBrowser({ config: int }));
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });

  it('does nothing at all inside the disagreement band', () => {
    const band = situation({ focus: { focusedSince: NOW - (GRACE + 100) }, config: int });
    const d = decide(band);
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/ambiguous|shape/i);
  });

  it('does not let an external rule fire inside the band either', () => {
    const band = situation({ focus: { focusedSince: NOW - (GRACE + 100) }, config: ext });
    expect(decide(band).action).toBe('leave');
  });

  it('is exact at both edges of the band', () => {
    const at = (age, cfg) => decide(situation({ focus: { focusedSince: NOW - age }, config: cfg }));
    expect(at(GRACE - 1, ext).action).toBe('reopen');
    expect(at(GRACE + 1, ext).action).toBe('leave');
    expect(at(2 * GRACE + 1, int).action).toBe('reopen');
    expect(at(2 * GRACE - 1, int).action).toBe('leave');
  });

  it('treats "we recorded no focus at all" as external, not as internal', () => {
    // Unknown must never become the permissive answer for internal rules.
    const d = decide(situation({ focus: { focusedSince: null }, config: int }));
    expect(d.action).toBe('leave');
  });
});

describe('RUNG 4 — entry rules', () => {
  it('applies only rules whose scope matches the entry shape', () => {
    const internalOnly = config({ rules: [rule({ scope: 'internal', to: 'work' })] });
    expect(decide(situation({ config: internalOnly })).action).toBe('leave');
  });

  it('takes the first match in compiled order and does no sorting of its own', () => {
    // Ordering is a property of the compiled artefact, so the order the
    // verifier tests is byte-identically the order the browser executes.
    const cfg = config({
      rules: [
        rule({ id: 'first', match: { host: 'example.com' }, to: 'work' }),
        rule({ id: 'second', match: { host: 'example.com' }, to: 'admin' }),
      ],
    });
    expect(decide(situation({ config: cfg }))).toMatchObject({
      ruleId: 'first',
      cookieStoreId: WORK,
    });
  });

  it('matches a host and its subdomains, and nothing that merely ends the same', () => {
    const cfg = config({ rules: [rule({ match: { host: 'example.com' }, to: 'work' })] });
    const at = (url) => decide(situation({ request: { url }, config: cfg })).action;
    expect(at('https://example.com/x')).toBe('reopen');
    expect(at('https://mail.example.com/x')).toBe('reopen');
    expect(at('https://notexample.com/x')).toBe('leave');
    expect(at('https://example.com.evil.test/x')).toBe('leave');
  });

  it('leaves a host on the never list alone, whatever else matches', () => {
    const cfg = config({
      never: ['example.com'],
      rules: [rule({ to: 'work' })],
    });
    expect(decide(situation({ config: cfg })).action).toBe('leave');
  });

  it('leaves the tab alone when the rule names a container this profile lacks', () => {
    // A name that does not resolve is inert-plus-warning, never a guess.
    const cfg = config({ rules: [rule({ to: 'nonesuch' })] });
    const d = decide(situation({ config: cfg }));
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/container|name/i);
  });
});

describe('RUNG 5 — ask', () => {
  it('asks when an internal rule explicitly says to', () => {
    const cfg = config({ rules: [rule({ scope: 'internal', to: 'ask' })] });
    const d = decide(insideBrowser({ config: cfg }));
    expect(d).toMatchObject({ action: 'ask', rung: 5 });
  });

  it('never asks on an external entry, because that is linkward territory', () => {
    // Two pickers on one territory is F2 rebuilt out of our own parts. The
    // compiler refuses this config; the engine refuses it again.
    const cfg = config({ rules: [rule({ scope: 'external', to: 'ask' })] });
    expect(decide(situation({ config: cfg })).action).toBe('leave');
  });

  it('offers every container this profile really has', () => {
    const cfg = config({ rules: [rule({ scope: 'internal', to: 'ask' })] });
    const d = decide(insideBrowser({ config: cfg }));
    expect(d.choices.map((c) => c.name)).toEqual(['personal', 'work', 'admin']);
  });

  it('is never reached by an unmatched navigation', () => {
    // Unknown is rung 6. An extension that asks when unsure teaches you to
    // dismiss it, and a prompt dismissed by reflex is worse than no prompt.
    expect(decide(insideBrowser({ config: config() })).action).toBe('leave');
  });
});

describe('RUNG 6 — leave alone is a named rung', () => {
  it('reports the rung and a reason even when it does nothing', () => {
    const d = decide(insideBrowser({ config: config() }));
    expect(d).toMatchObject({ action: 'leave', rung: 6 });
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('returns exactly one action, always', () => {
    for (const s of [situation(), insideBrowser(), situation({ config: null })]) {
      const d = decide(s);
      expect(['leave', 'reopen', 'ask']).toContain(d.action);
    }
  });
});
