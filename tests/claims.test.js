// The claim registry — the only way provenance crosses an extension boundary.
//
// No extension can see which extension opened a tab. That is the platform
// boundary, not an oversight to route around, so claims are not a convenience:
// they are the mechanism. Every shape below was learned the hard way in
// linkward's own claim map and is inherited rather than rediscovered.

import { describe, it, expect } from 'vitest';
import { createClaims } from '../src/lib/claims.js';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';
const WORK = 'firefox-container-2';
const ADMIN = 'firefox-container-4';
const BEELINE = 'beeline@sapn95.github.io';
const LINKWARD = 'linkward@sapn95.github.io';
const STRANGER = 'someone-else@example.com';

const ALLOW = [BEELINE, LINKWARD];
const TTL = 10_000;

const make = () => createClaims({ allow: ALLOW, ttlMs: TTL });

describe('staking and consuming a claim', () => {
  it('consumes a claim matching the url a tab was created with', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, 100)).toMatchObject({ cookieStoreId: WORK });
  });

  it('matches pendingUrl too, because browsers disagree about which one carries it', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: '', pendingUrl: URL_A }, 100)).toBeTruthy();
  });

  it('does not consume a claim for a different url', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_B }, 100)).toBeNull();
  });

  it('spends a claim exactly once', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, 100)).toBeTruthy();
    expect(c.consume({ id: 8, url: URL_A }, 200)).toBeNull();
  });

  it('does not let a spent claim swallow the next genuine link', () => {
    // A claim left standing means the very next tab from another application
    // is taken for ours and never asked about.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.consume({ id: 7, url: URL_A }, 100);
    expect(c.consume({ id: 9, url: URL_A }, 150)).toBeNull();
  });
});

describe('two launches at once', () => {
  it('keeps two claims for different urls apart', () => {
    // A shared counter got both halves wrong: the first to finish cancelled the
    // second, and while either was in flight ANY new tab was taken for ours.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.claim({ url: URL_B, cookieStoreId: ADMIN, sender: BEELINE }, 0);
    expect(c.consume({ id: 1, url: URL_B }, 10)).toMatchObject({ cookieStoreId: ADMIN });
    expect(c.consume({ id: 2, url: URL_A }, 20)).toMatchObject({ cookieStoreId: WORK });
  });

  it('consumes two claims for the SAME url in the order they were staked', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.claim({ url: URL_A, cookieStoreId: ADMIN, sender: BEELINE }, 1);
    expect(c.consume({ id: 1, url: URL_A }, 10)).toMatchObject({ cookieStoreId: WORK });
    expect(c.consume({ id: 2, url: URL_A }, 11)).toMatchObject({ cookieStoreId: ADMIN });
  });

  it('does not let one launch finishing cancel the other', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.claim({ url: URL_B, cookieStoreId: ADMIN, sender: BEELINE }, 0);
    c.consume({ id: 1, url: URL_A }, 10);
    expect(c.consume({ id: 2, url: URL_B }, 20)).toBeTruthy();
  });
});

describe('releasing', () => {
  it('drops a claim whose tabs.create failed', () => {
    // Without this the stale claim sits there until its TTL and swallows the
    // next genuinely external link at that address.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.release({ url: URL_A, sender: BEELINE }, 5);
    expect(c.consume({ id: 7, url: URL_A }, 10)).toBeNull();
  });

  it('drops only one of two claims for the same url', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    c.claim({ url: URL_A, cookieStoreId: ADMIN, sender: BEELINE }, 1);
    c.release({ url: URL_A, sender: BEELINE }, 5);
    expect(c.consume({ id: 7, url: URL_A }, 10)).toBeTruthy();
    expect(c.consume({ id: 8, url: URL_A }, 11)).toBeNull();
  });
});

describe('expiry', () => {
  it('ignores a claim older than the TTL', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, TTL + 1)).toBeNull();
  });

  it('evaluates the TTL lazily, without timers', () => {
    // A timer in an event page is a promise the platform does not keep.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, TTL - 1)).toBeTruthy();
  });

  it('never turns an expired claim into a question', () => {
    // Expiry means "we do not know", and unknown is leave-alone.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, TTL + 1)).toBeNull();
  });
});

describe('binding to a tab', () => {
  it('keeps a bound tab hands-off after the first request', () => {
    const c = make();
    c.bind({ tabId: 42, url: URL_A, sender: BEELINE }, 0);
    expect(c.isOurs(42)).toBe(true);
  });

  it('forgets a bound tab when it closes, so a reused id is not hands-off', () => {
    // Firefox reuses tab ids. A stale binding would silently exempt a stranger.
    const c = make();
    c.bind({ tabId: 42, url: URL_A, sender: BEELINE }, 0);
    c.forget(42);
    expect(c.isOurs(42)).toBe(false);
  });
});

describe('trust', () => {
  it('ignores a claim from an extension that is not on the allowlist', () => {
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: WORK, sender: STRANGER }, 0);
    expect(c.consume({ id: 7, url: URL_A }, 10)).toBeNull();
  });

  it('ignores a stranger silently — other extensions are allowed to exist', () => {
    const c = make();
    expect(() => c.claim({ url: URL_A, cookieStoreId: WORK, sender: STRANGER }, 0)).not.toThrow();
  });

  it('ignores malformed messages rather than throwing into the message handler', () => {
    const c = make();
    for (const junk of [undefined, null, {}, { url: 5 }, { url: URL_A }]) {
      expect(() => c.claim(junk, 0)).not.toThrow();
    }
    expect(c.consume({ id: 7, url: URL_A }, 10)).toBeNull();
  });

  it('takes the cookieStoreId the sender actually used, including the default one', () => {
    // A launcher without container permission must claim firefox-default rather
    // than the container it could not use. Claiming one you did not open is
    // worse than not claiming.
    const c = make();
    c.claim({ url: URL_A, cookieStoreId: 'firefox-default', sender: BEELINE }, 0);
    expect(c.consume({ id: 7, url: URL_A }, 10)).toMatchObject({
      cookieStoreId: 'firefox-default',
    });
  });
});
