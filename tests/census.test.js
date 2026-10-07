// The peer census.
//
// This module exists because of a bug that nothing in either extension could
// see: commander routing `*.example.com` from managed storage while linkward held its
// own `docs.example.com` rule with interception on. Both held a blocking
// webRequest listener, both cancelled the same request, both opened a
// replacement — and Firefox carried out both. Every bookmark on those hosts
// opened in a pair, for weeks, with both extensions reporting themselves
// healthy, because an extension cannot enumerate another extension's listeners.
//
// So the cases below are not hypotheticals. The first one IS the bug.

import { describe, it, expect } from 'vitest';
import {
  routingState,
  routeHosts,
  overlapping,
  clashes,
  clashLine,
  standDownHosts,
  allStandingDown,
  silentRouters,
} from '../src/lib/census.js';

const SELF = { routing: true, routes: ['*.example.com'] };

const LINKWARD = {
  id: 'linkward@sapn95.github.io',
  name: 'linkward',
  version: '0.1.0',
  routing: true,
  routes: ['docs.example.com', 'code.example.com', 'flow.example.com', 'elsewhere.example'],
};

describe('what this extension reports about itself', () => {
  it('is routing when it is watching, has a policy and is not paused', () => {
    const s = routingState({ watching: true, inert: false, paused: false, config: { rules: [] } });
    expect(s.routing).toBe(true);
    expect(s.dryRun).toBe(false);
  });

  // Each of these three is a state the extension genuinely gets into, and in
  // each of them it cancels nothing — so claiming to route would put a warning
  // in a peer's settings page about a clash that cannot happen.
  it.each([
    ['without the watch grant', { watching: false, inert: false, paused: false }],
    ['with no policy loaded', { watching: true, inert: true, paused: false }],
    ['while paused', { watching: true, inert: false, paused: true }],
  ])('is not routing %s', (_label, state) => {
    expect(routingState({ ...state, config: { rules: [] } }).routing).toBe(false);
  });

  it('reports a dry run separately rather than as routing', () => {
    // A dry run decides everything and cancels nothing, so it cannot produce a
    // pair of tabs. Reported anyway: "this will clash the moment you switch it
    // on" is worth knowing BEFORE switching it on.
    const s = routingState({
      watching: true,
      inert: false,
      paused: false,
      config: { dryRun: true, rules: [{ id: 'a', match: { host: 'x.example' } }] },
    });
    expect(s.routing).toBe(false);
    expect(s.dryRun).toBe(true);
    expect(s.routes).toEqual(['x.example']);
  });

  it('answers with an empty route list rather than throwing on no config at all', () => {
    expect(routingState()).toEqual({ routing: false, dryRun: false, routes: [] });
  });
});

describe('the routes it publishes', () => {
  it('names hosts, and a regex rule by the host it is anchored to', () => {
    // The PATTERN is still never published — a page of escaped alternations
    // helps nobody and leaks policy detail for nothing. The host it lands on is
    // a different thing, and it is the only part a peer can act on: an id it
    // cannot match leaves it asking about a host this extension is routing.
    expect(
      routeHosts({
        rules: [
          { id: 'corp-wide', match: { host: '*.example.com' } },
          { id: 'msal-terminal', match: { regex: '^https://login\\.example-idp\\.com/x' } },
        ],
      }),
    ).toEqual(['*.example.com', 'login.example-idp.com']);
  });

  it('skips a rule that names neither a host nor an id', () => {
    // Off a wire this extension does not control. A rule with an empty host
    // string would otherwise publish '' and compare equal to nothing, which is
    // an entry in a warning list that says nothing.
    expect(routeHosts({ rules: [{ match: { host: '' } }, {}, null] })).toEqual([]);
  });

  it('says one host once', () => {
    // Two rules on one host with different paths are one host to a reader.
    expect(
      routeHosts({
        rules: [
          { id: 'a', match: { host: 'x.example', path: '/one' } },
          { id: 'b', match: { host: 'x.example', path: '/two' } },
        ],
      }),
    ).toEqual(['x.example']);
  });
});

describe('the overlap between two route lists', () => {
  it('sees a wildcard and a bare host as the same jurisdiction', () => {
    // NOT set intersection. `*.example.com` and `docs.example.com` never compare
    // equal, and that pair is the entire bug.
    expect(overlapping(['*.example.com'], ['docs.example.com'])).toEqual(['docs.example.com']);
  });

  it('reads the pair the same way round', () => {
    expect(overlapping(['docs.example.com'], ['*.example.com'])).toEqual(['docs.example.com']);
  });

  it('counts the apex as covered by its own wildcard', () => {
    // `*.example.com` in this policy language includes `example.com` itself, and the
    // engine treats it that way — so the census must too, or it under-reports.
    expect(overlapping(['*.example.com'], ['example.com'])).toEqual(['example.com']);
  });

  it('does not match a suffix that is not a label boundary', () => {
    expect(overlapping(['*.example.com'], ['notexample.com'])).toEqual([]);
  });

  it('finds nothing between two unrelated lists', () => {
    expect(overlapping(['a.example'], ['b.example'])).toEqual([]);
  });
});

describe('finding the extensions that are also routing', () => {
  it('reports a peer that routes the same hosts', () => {
    const found = clashes(SELF, [LINKWARD]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('linkward');
    expect(found[0].overlap).toEqual(['docs.example.com', 'code.example.com', 'flow.example.com']);
  });

  it('says nothing about a peer that is installed but not routing', () => {
    // One router is the working state, whichever one it is. A warning that fires
    // on a peer merely being installed is the warning everybody clicks past —
    // and then the one time it is real, it gets clicked past too.
    expect(clashes(SELF, [{ ...LINKWARD, routing: false }])).toEqual([]);
  });

  it('says nothing when this extension is the one not routing', () => {
    expect(clashes({ routing: false, routes: [] }, [LINKWARD])).toEqual([]);
  });

  it('still reports a routing peer whose hosts do not overlap', () => {
    // Overlap is what makes it visible, not what makes it true: a regex rule on
    // either side is published as an id, so two extensions can collide on a host
    // neither of them named in a comparable way.
    const found = clashes(SELF, [{ ...LINKWARD, routes: ['rule:something'] }]);
    expect(found).toHaveLength(1);
    expect(found[0].overlap).toEqual([]);
  });

  it('puts the worst overlap first', () => {
    const small = { ...LINKWARD, name: 'small', routes: ['flow.example.com'] };
    expect(clashes(SELF, [small, LINKWARD]).map((f) => f.name)).toEqual(['linkward', 'small']);
  });

  // Every one of these arrives from another extension's message handler across a
  // boundary this one does not control, so none of it is trusted.
  it.each([
    ['a peer that did not answer', null],
    ['a timeout', undefined],
    ['a string', 'yes'],
    ['a reply with no routing field', { name: 'x' }],
  ])('ignores %s', (_label, answer) => {
    expect(clashes(SELF, [answer])).toEqual([]);
  });

  it('falls back to the id, then to a generic name, when a peer names itself badly', () => {
    // A peer answering without a name still has to be reportable: the whole
    // point is telling somebody WHICH add-on to go and switch off.
    const [byId] = clashes(SELF, [{ id: 'linkward@sapn95.github.io', routing: true }]);
    expect(byId.name).toBe('linkward@sapn95.github.io');
    expect(byId.version).toBe('');
    expect(byId.id).toBe('linkward@sapn95.github.io');

    const [anon] = clashes(SELF, [{ routing: true }]);
    expect(anon.name).toBe('another extension');
    expect(anon.id).toBe('');
  });

  it('does not report a blank or a non-string as the extension to go and switch off', () => {
    // An empty name passed the old string check and came out as nothing at all,
    // and an id that is not a string came out as whatever String() makes of it.
    // The tooltip has to name something somebody can find in their add-ons list.
    const [blank] = clashes(SELF, [
      { name: '   ', id: 'linkward@sapn95.github.io', routing: true },
    ]);
    expect(blank.name).toBe('linkward@sapn95.github.io');

    for (const bad of [{ id: 42 }, { id: {} }, { id: '' }, { name: '', id: null }]) {
      const [found] = clashes(SELF, [{ ...bad, routing: true }]);
      expect(found.name).toBe('another extension');
      expect(found.id).toBe('');
    }
  });

  it('compares against an empty route list of its own without throwing', () => {
    // routingState() can report routing with no host rules at all: a policy of
    // nothing but regex rules publishes ids, and `routes` can legitimately be [].
    const [found] = clashes({ routing: true }, [LINKWARD]);
    expect(found.overlap).toEqual([]);
  });

  it('survives a reply whose routes are not a list of strings', () => {
    const found = clashes(SELF, [{ ...LINKWARD, routes: [1, null, 'code.example.com'] }]);
    expect(found[0].routes).toEqual(['code.example.com']);
  });
});

describe('the sentence it puts on screen', () => {
  it('names the extension, the shared hosts and what to do', () => {
    const line = clashLine(clashes(SELF, [LINKWARD]));
    expect(line).toContain('linkward 0.1.0');
    expect(line).toContain('docs.example.com');
    expect(line).toContain('two tabs');
    expect(line).toContain('Switch routing off in one of them.');
  });

  it('truncates a long shared list rather than filling the panel with it', () => {
    const many = {
      ...LINKWARD,
      routes: ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'],
    };
    const line = clashLine(clashes(SELF, [many]));
    expect(line).toContain('a.example.com, b.example.com, c.example.com, …');
    expect(line).not.toContain('d.example.com');
  });

  it('drops the version from the sentence when the peer did not send one', () => {
    expect(clashLine(clashes(SELF, [{ name: 'linkward', routing: true }]))).toMatch(
      /^linkward is also routing/,
    );
  });

  it('counts the others when more than one is routing', () => {
    const other = { ...LINKWARD, id: 'b@x', name: 'beeline', routes: ['code.example.com'] };
    expect(clashLine(clashes(SELF, [LINKWARD, other]))).toContain('(and 1 more)');
  });

  it('is null when nothing clashes, so a page can test it directly', () => {
    expect(clashLine([])).toBeNull();
    expect(clashLine()).toBeNull();
  });
});

// The durable half of the fix the popup offers. Pause lasts until Firefox
// restarts; this is the list that goes in the policy file so it lasts longer,
// and every case below is something that would otherwise be pasted into
// `never` and quietly match nothing.
describe('the hosts to hand over when this extension stands down', () => {
  it('names the shared hosts, because those are the tabs arriving in pairs', () => {
    expect(
      standDownHosts([
        { overlap: ['docs.example.com'], routes: ['docs.example.com', 'code.example.com'] },
      ]),
    ).toEqual(['docs.example.com']);
  });

  it('falls back to the whole route list for a peer that overlaps on nothing', () => {
    // No shared host does not mean no clash: it is holding the same requests,
    // and neither side has published a comparable pattern for them.
    expect(standDownHosts([{ overlap: [], routes: ['code.example.com'] }])).toEqual([
      'code.example.com',
    ]);
  });

  it('drops the star, because this policy language has no globs', () => {
    // `never` matches a host and every subdomain of it, so `example.com` is what
    // `*.example.com` means here. Left alone the star matches nothing at all and
    // the policy looks correct while the pair carries on.
    expect(standDownHosts([{ overlap: ['*.example.com'] }])).toEqual(['example.com']);
  });

  it('drops a rule id, which is a label and not a host', () => {
    // A regex rule is published as its id rather than its source. Pasted into
    // `never` it fails validation, and the fix dies on a typo nobody wrote.
    expect(standDownHosts([{ overlap: [], routes: ['rule:msal', 'code.example.com'] }])).toEqual([
      'code.example.com',
    ]);
  });

  it('merges two peers into one list, sorted, without repeats', () => {
    expect(
      standDownHosts([
        { overlap: ['b.example.com'] },
        { overlap: ['a.example.com', 'B.example.com'] },
      ]),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('answers with an empty list rather than throwing on junk', () => {
    // Everything here crossed an extension boundary this one does not control.
    expect(standDownHosts()).toEqual([]);
    expect(standDownHosts([null, {}, { overlap: [42, '', '   '] }])).toEqual([]);
  });
});

// Found by running the real installed policy through both extensions instead of
// reasoning about it: three of its twelve rules published as `rule:<id>`, all
// three `scope: external`, all three anchored to one host. A peer cannot match
// an id, so it kept asking about hosts this extension was routing — the pair,
// on precisely the sign-in hand-offs a regex rule gets written for.
describe('what a regex rule publishes', () => {
  const pub = (regex, id = 'r') => routeHosts({ rules: [{ id, match: { regex } }] });

  it('publishes the host when the pattern is anchored to exactly one', () => {
    expect(pub('^https://login\\.example\\.com/oauth2/')).toEqual(['login.example.com']);
  });

  it('accepts the optional-s scheme and drops a port', () => {
    // A peer matches on host alone, so a port left on would match nothing.
    expect(pub('^https?://127\\.0\\.0\\.1:35001/callback')).toEqual(['127.0.0.1']);
  });

  it('keeps the id when the pattern could match more than one host', () => {
    // Publishing one half of an alternation would have a peer stand down on
    // that host and go on doubling the other, which is worse than not helping.
    expect(pub('^https://(a|b)\\.example\\.com/', 'alt')).toEqual(['rule:alt']);
    expect(pub('^https://.*\\.example\\.com/', 'any')).toEqual(['rule:any']);
    expect(pub('^https://[ab]\\.example\\.com/', 'cls')).toEqual(['rule:cls']);
    expect(pub('^https://a?\\.example\\.com/', 'opt')).toEqual(['rule:opt']);
  });

  it('keeps the id when the host is not closed off', () => {
    // A prefix match: `^https://a\\.example\\.com` with nothing after it also
    // matches a.example.com.evil.test, so the host is not the set of things
    // the rule routes and must not be published as if it were.
    expect(pub('^https://login\\.example\\.com', 'open')).toEqual(['rule:open']);
    expect(pub('^https://login\\.example\\.com$')).toEqual(['login.example.com']);
  });

  it('keeps the id when a bare alternation splits the whole pattern', () => {
    // Position does not matter and depth does. This one reads cleanly as one
    // host and routes a second the prefix never sees, which is the exact harm
    // publishing a host is supposed to avoid.
    expect(pub('^https://a\\.example\\.com/|^https://b\\.other\\.com/', 'split')).toEqual([
      'rule:split',
    ]);
  });

  it('allows an alternation that only chooses a path', () => {
    // Inside a group it picks between two paths under one host. Rejecting it
    // would cost a hand-over for nothing.
    expect(pub('^https://a\\.example\\.com/(x|y)')).toEqual(['a.example.com']);
    // An escaped pipe is a literal in a path, not the operator.
    expect(pub('^https://a\\.example\\.com/x\\|y')).toEqual(['a.example.com']);
    // And inside a character class it is a literal too.
    expect(pub('^https://a\\.example\\.com/[a|b]')).toEqual(['a.example.com']);
  });

  it('keeps the id when the pattern is not anchored at all', () => {
    // Unanchored, it can match the host anywhere in the URL — including inside
    // a query string on a completely different site.
    expect(pub('https://example\\.com/', 'loose')).toEqual(['rule:loose']);
  });

  it('still publishes a plain host rule as itself, and dedupes', () => {
    expect(
      routeHosts({
        rules: [
          { id: 'a', match: { host: '*.example.com' } },
          { id: 'b', match: { regex: '^https://login\\.example\\.net/x' } },
          { id: 'c', match: { regex: '^https://login\\.example\\.net/y' } },
        ],
      }),
    ).toEqual(['*.example.com', 'login.example.net']);
  });
});

// The warning survived its own remedy. linkward gives way on every host this
// policy publishes, and the popup went on saying "switch routing off in one of
// them" — asking for a fix that had already happened, which is how a warning
// stops being read the next time it is right.
describe('a peer that has given way', () => {
  const SELF = { id: 'me@example.com', routing: true, routes: ['*.example.com'] };
  const GAVE_WAY = {
    id: 'linkward@example.com',
    name: 'linkward',
    version: '0.8.0',
    routing: true,
    routes: [],
    defersTo: ['me@example.com'],
  };

  it('is marked, not dropped: it still holds the same requests', () => {
    // A host this policy reopens from a bookmark folder matched no rule, so it
    // is on no published list and the peer never stood down on it.
    const [found] = clashes(SELF, [GAVE_WAY]);
    expect(found.standingDown).toBe(true);
    expect(found.name).toBe('linkward');
  });

  it('is not marked when it claims to give way and still claims the hosts', () => {
    // One reply contradicting itself. The overlap is the half backed by
    // evidence — those are the hosts both would act on — so believe that half
    // rather than the claim sitting beside it.
    const [found] = clashes(SELF, [{ ...GAVE_WAY, routes: ['docs.example.com'] }]);
    expect(found.overlap).toEqual(['docs.example.com']);
    expect(found.standingDown).toBe(false);
  });

  it('is not marked when it names somebody else', () => {
    const [found] = clashes(SELF, [{ ...GAVE_WAY, defersTo: ['third@example.com'] }]);
    expect(found.standingDown).toBe(false);
  });

  it('is not marked when this extension does not know its own id', () => {
    // Guessing would quiet a warning that is still entirely true.
    const [found] = clashes({ ...SELF, id: undefined }, [GAVE_WAY]);
    expect(found.standingDown).toBe(false);
    expect(clashes({ ...SELF, id: '' }, [GAVE_WAY])[0].standingDown).toBe(false);
  });

  it('sorts below a peer that is still fighting, whatever either overlaps', () => {
    // The first entry is the one the one-line warning names, so this ordering
    // decides whether that line is an alarm or a statement.
    const fighting = {
      id: 'other@example.com',
      name: 'other',
      routing: true,
      routes: ['unrelated.example.net'],
    };
    const [first, second] = clashes(SELF, [GAVE_WAY, fighting]);
    expect(first.name).toBe('other');
    expect(second.name).toBe('linkward');
  });

  it('stops the sentence asking for a fix that already happened', () => {
    const line = clashLine(clashes(SELF, [GAVE_WAY]));
    expect(line).toMatch(/gives way/i);
    expect(line).not.toMatch(/switch routing off/i);
    // And still says what is left, because something is.
    expect(line).toMatch(/bookmark folder/i);
    expect(line).toMatch(/can still open twice/i);
  });

  it('keeps the alarm while any of them is still routing against it', () => {
    const fighting = { id: 'o@example.com', name: 'other', routing: true, routes: [] };
    const line = clashLine(clashes(SELF, [GAVE_WAY, fighting]));
    expect(line).toMatch(/switch routing off/i);
  });

  it('answers whether the whole census has given way', () => {
    expect(allStandingDown(clashes(SELF, [GAVE_WAY]))).toBe(true);
    expect(allStandingDown([])).toBe(false);
    expect(allStandingDown()).toBe(false);
  });
});

// Multi-Account Containers ran beside this add-on for weeks: a blocking
// listener, a list of site assignments, no protocol, and therefore invisible to
// every check either side could run. It is found by CAPABILITY and never by
// name — a list of known ids goes stale the first time somebody installs the
// next container add-on, and learning one would need a release.
describe('add-ons that route and never answer', () => {
  const ext = (over) => ({
    id: 'other@example.com',
    name: 'Other',
    version: '1.0',
    type: 'extension',
    enabled: true,
    permissions: [],
    hostPermissions: [],
    ...over,
  });
  const WHO = { selfId: 'me@example.com', answeredIds: ['peer@example.com'] };

  it('names one that can open tabs in containers', () => {
    const [found] = silentRouters([ext({ permissions: ['contextualIdentities', 'cookies'] })], WHO);
    expect(found.name).toBe('Other');
    expect(found.why).toEqual(['opens tabs in containers']);
  });

  it('names one that can take a request before it is sent', () => {
    const [found] = silentRouters(
      [ext({ permissions: ['webRequestBlocking'], hostPermissions: ['<all_urls>'] })],
      WHO,
    );
    expect(found.why).toEqual(['can take a request before it is sent']);
  });

  it('says both reasons when both are declared', () => {
    const [found] = silentRouters(
      [
        ext({
          permissions: ['contextualIdentities', 'cookies', 'webRequestBlocking'],
          hostPermissions: ['https://*/*'],
        }),
      ],
      WHO,
    );
    expect(found.why).toHaveLength(2);
  });

  it('ignores a blocking listener with nowhere to run', () => {
    // Measured on a real profile: an add-on whose only host pattern is its own
    // moz-extension:// origin cannot see a navigation, and reporting it would
    // be a second router that does not exist.
    expect(
      silentRouters(
        [
          ext({
            permissions: ['webRequestBlocking'],
            hostPermissions: ['moz-extension://00000000-0000-4000-8000-000000000000/*'],
          }),
        ],
        WHO,
      ),
    ).toEqual([]);
  });

  it('ignores a disabled add-on', () => {
    // It routes nothing. Naming it is the warning people learn to click past,
    // so that the time it is real it gets clicked past too.
    expect(
      silentRouters(
        [ext({ enabled: false, permissions: ['contextualIdentities', 'cookies'] })],
        WHO,
      ),
    ).toEqual([]);
  });

  it('ignores contextualIdentities without cookies', () => {
    // tabs.create refuses a cookieStoreId without `cookies`, so an add-on
    // holding only the first can list containers and never open a tab in one.
    expect(silentRouters([ext({ permissions: ['contextualIdentities'] })], WHO)).toEqual([]);
  });

  it('names a peer that is installed and said nothing', () => {
    // The case this whole function exists for. A peer whose background never
    // started answers exactly like one that is not installed, and excluding it
    // by configured id would hide the one peer whose report cannot be trusted.
    const [found] = silentRouters(
      [ext({ id: 'silent@example.com', permissions: ['contextualIdentities', 'cookies'] })],
      { selfId: 'me@example.com', answeredIds: [] },
    );
    expect(found.id).toBe('silent@example.com');
  });

  it('ignores this extension and the peers that answered', () => {
    // A peer is in the census by name with what it is actually doing. Listing
    // it twice would say a protocol that works is a problem.
    const both = [
      ext({ id: 'me@example.com', permissions: ['contextualIdentities', 'cookies'] }),
      ext({ id: 'peer@example.com', permissions: ['contextualIdentities', 'cookies'] }),
    ];
    expect(silentRouters(both, WHO)).toEqual([]);
  });

  it('ignores a theme and anything that declares neither', () => {
    expect(
      silentRouters(
        [ext({ type: 'theme', permissions: ['contextualIdentities', 'cookies'] })],
        WHO,
      ),
    ).toEqual([]);
    expect(silentRouters([ext({ permissions: ['storage', 'tabs'] })], WHO)).toEqual([]);
  });

  it('answers with an empty list rather than throwing on junk', () => {
    expect(silentRouters()).toEqual([]);
    expect(silentRouters([null, 'nope', {}, ext({ id: '' })], WHO)).toEqual([]);
    expect(silentRouters([ext({ permissions: 'nope', hostPermissions: 7 })], WHO)).toEqual([]);
  });

  it('names something findable when an add-on names itself badly', () => {
    const [found] = silentRouters(
      [ext({ name: '   ', permissions: ['contextualIdentities', 'cookies'] })],
      WHO,
    );
    expect(found.name).toBe('other@example.com');
  });

  it('sorts by name, because the list is read', () => {
    const rows = silentRouters(
      [
        ext({
          id: 'b@example.com',
          name: 'Zebra',
          permissions: ['contextualIdentities', 'cookies'],
        }),
        ext({
          id: 'a@example.com',
          name: 'Alpha',
          permissions: ['contextualIdentities', 'cookies'],
        }),
      ],
      WHO,
    );
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
  });
});
