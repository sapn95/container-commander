// GATE 0 — what the extension refuses to have an opinion about.
//
// This is written first because it is the only part of the ladder that protects
// somebody's data rather than their identity: a reopened POST is a lost form
// submission, and no routing decision is worth that.

import { describe, it, expect } from 'vitest';
import { decide } from '../src/lib/engine.js';
import { situation, WORK, config, rule } from './helpers/situation.js';

const routed = config({ rules: [rule({ to: 'work' })] });

describe('GATE 0 — scope', () => {
  it('routes an ordinary fresh GET, so the rest of these cases mean something', () => {
    const d = decide(situation({ config: routed }));
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });

  it('never reopens a POST, because the body cannot survive it', () => {
    // tabs.create takes a URL and nothing else, so a "corrected" POST is
    // replayed as a fresh GET with the body gone. The user typed that.
    const d = decide(situation({ request: { method: 'POST' }, config: routed }));
    expect(d.action).toBe('leave');
  });

  it('says out loud that it refused a POST, rather than going quiet', () => {
    // A deterministic route that silently does not fire is indistinguishable
    // from a broken config — the exact way F6 hid for two days.
    const d = decide(situation({ request: { method: 'POST' }, config: routed }));
    expect(d.reason).toMatch(/post|method/i);
    expect(d.rung).toBe(0);
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])('refuses %s as well', (method) => {
    expect(decide(situation({ request: { method }, config: routed })).action).toBe('leave');
  });

  it.each([
    'about:config',
    'file:///Users/me/notes.txt',
    'moz-extension://abc/page.html',
    'data:text/html,<h1>',
    'javascript:alert(1)',
  ])('leaves %s alone — it could not be reopened meaningfully', (url) => {
    expect(decide(situation({ request: { url }, config: routed })).action).toBe('leave');
  });

  it('leaves a tab that has already been decided about', () => {
    // One decision per tab, whichever way it went. Without this the freshness
    // window gives the same tab a second chance for five more seconds.
    const d = decide(situation({ candidate: { spent: true }, config: routed }));
    expect(d.action).toBe('leave');
  });

  it('leaves a tab that was never flagged as a candidate', () => {
    const d = decide(situation({ candidate: { since: undefined }, config: routed }));
    expect(d.action).toBe('leave');
  });

  it('leaves a tab whose first navigation is no longer fresh', () => {
    // Only the FIRST navigation after a tab appears can be the one it was
    // created for. Everything after is somebody browsing.
    const stale = situation({ candidate: { since: 1 }, config: routed });
    expect(decide(stale).action).toBe('leave');
  });

  it('is exact at the freshness boundary, in the direction that does nothing', () => {
    const at = situation({ candidate: { since: 0 }, now: 5000, config: routed });
    const just = situation({ candidate: { since: 0 }, now: 4999, config: routed });
    expect(decide(at).action).toBe('leave');
    expect(decide(just).action).toBe('reopen');
  });
});

describe('GATE 0 — when the extension should behave as if absent', () => {
  it('leaves everything alone in dryRun, but still says what it would have done', () => {
    // The migration soak depends on this: enforcement off, opinion on.
    const d = decide(situation({ config: config({ ...routed, dryRun: true }) }));
    expect(d.action).toBe('leave');
    expect(d.wouldHave).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });

  it('leaves everything alone when there is no config at all', () => {
    // storage.managed rejects when no native manifest exists. That is a fresh
    // install, not a failure.
    expect(decide(situation({ config: null })).action).toBe('leave');
  });

  it('leaves everything alone when the config failed validation', () => {
    expect(decide(situation({ config: config({ invalid: true }) })).action).toBe('leave');
  });

  it('never throws, whatever it is handed', () => {
    // This runs inside a blocking listener. A thrown error here is holding up
    // somebody's page.
    for (const junk of [undefined, null, {}, { request: null }, { tab: null }]) {
      expect(() => decide(junk)).not.toThrow();
      expect(decide(junk).action).toBe('leave');
    }
  });
});
