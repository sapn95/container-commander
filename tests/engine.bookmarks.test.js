// Bookmark hints — the weakest tier, and the one most able to do damage
// quietly, because a hint is evidence about where you once FILED a URL and not
// about where this navigation belongs.

import { describe, it, expect } from 'vitest';
import { decide } from '../src/lib/engine.js';
import { situation, insideBrowser, config, rule, WORK, PERSONAL } from './helpers/situation.js';

const folders = [
  { path: 'toolbar/Work', container: 'work' },
  { path: 'toolbar/Personal', container: 'personal' },
];
const hint = (container, folderPath = 'toolbar/Work') => [{ folderPath, container }];
const withFolders = (over = {}) => config({ bookmarks: { folders, onConflict: 'leave' }, ...over });

describe('a hint on an internal entry', () => {
  it('routes to the folder its container is mapped to', () => {
    const d = decide(insideBrowser({ bookmarkHits: hint('work'), config: withFolders() }));
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });

  it('names the folder as the reason, not a rule id', () => {
    const d = decide(insideBrowser({ bookmarkHits: hint('work'), config: withFolders() }));
    expect(d.ruleId).toBe('bookmark:toolbar/Work');
  });

  it('never fires on an external entry, however well filed the URL is', () => {
    // An outside hand-off that happens to be bookmarked is still an outside
    // hand-off, and belongs to whoever asks about those.
    const d = decide(situation({ bookmarkHits: hint('work'), config: withFolders() }));
    expect(d.action).toBe('leave');
  });

  it('leaves the tab alone when the folder names a container this profile lacks', () => {
    const d = decide(insideBrowser({ bookmarkHits: hint('nonesuch'), config: withFolders() }));
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/container/i);
  });
});

describe('the same URL filed in two folders', () => {
  const both = [...hint('work'), ...hint('personal', 'toolbar/Personal')];

  it('does nothing by default, because a conflict is not a decision', () => {
    const d = decide(insideBrowser({ bookmarkHits: both, config: withFolders() }));
    expect(d.action).toBe('leave');
    expect(d.reason).toMatch(/conflict/i);
  });

  it('asks instead when the config says to', () => {
    const cfg = config({ bookmarks: { folders, onConflict: 'ask' } });
    const d = decide(insideBrowser({ bookmarkHits: both, config: cfg }));
    expect(d.action).toBe('ask');
  });

  it('routes without complaint when both folders agree', () => {
    const agreeing = [...hint('work'), ...hint('work', 'toolbar/Work Copy')];
    const d = decide(insideBrowser({ bookmarkHits: agreeing, config: withFolders() }));
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
  });
});

describe('a hint that must not become a side door', () => {
  const IDP = 'login.example-idp.com';

  it('is discarded on an auth host', () => {
    // A bare sign-in URL filed in a work folder would silently route a login
    // into one identity — the identity-provider yank, arriving through the
    // bookmarks tree instead of through a rule.
    const d = decide(
      insideBrowser({
        request: { url: `https://${IDP}/tenant/authorize` },
        bookmarkHits: hint('work'),
        config: withFolders({ authHosts: [IDP] }),
      }),
    );
    expect(d.action).toBe('leave');
  });

  it('is discarded on a never host', () => {
    const d = decide(
      insideBrowser({
        request: { url: 'https://console.example-cloud.com/home' },
        bookmarkHits: hint('work'),
        config: withFolders({ never: ['console.example-cloud.com'] }),
      }),
    );
    expect(d.action).toBe('leave');
  });
});

describe('a rule and a hint disagreeing', () => {
  it('lets the rule win, and reports what it overrode', () => {
    // The outcome is deterministic either way; what matters is that it is
    // visible. Silence nobody can see is how the federation-endpoint failure
    // hid for two days.
    const cfg = withFolders({ rules: [rule({ scope: 'internal', to: 'work' })] });
    const d = decide(
      insideBrowser({ bookmarkHits: hint('personal', 'toolbar/Personal'), config: cfg }),
    );
    expect(d).toMatchObject({ action: 'reopen', cookieStoreId: WORK });
    expect(d.suppressedHints).toEqual([{ folderPath: 'toolbar/Personal', container: 'personal' }]);
  });

  it('preselects the hint when the rule asks rather than routes', () => {
    const cfg = withFolders({ rules: [rule({ scope: 'internal', to: 'ask' })] });
    const d = decide(
      insideBrowser({ bookmarkHits: hint('personal', 'toolbar/Personal'), config: cfg }),
    );
    expect(d).toMatchObject({ action: 'ask', preselect: 'personal' });
  });

  it('offers every container in the picker regardless of the hint', () => {
    const cfg = withFolders({ rules: [rule({ scope: 'internal', to: 'ask' })] });
    const d = decide(
      insideBrowser({ bookmarkHits: hint('personal', 'toolbar/Personal'), config: cfg }),
    );
    expect(d.choices.map((c) => c.cookieStoreId)).toContain(PERSONAL);
    expect(d.choices).toHaveLength(3);
  });
});
