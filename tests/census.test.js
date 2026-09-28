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
  it('names hosts and reduces a regex rule to its id', () => {
    // A page of escaped alternations does not help the person deciding which
    // add-on to switch off, and shipping one into another extension's UI would
    // leak policy detail for nothing.
    expect(
      routeHosts({
        rules: [
          { id: 'corp-wide', match: { host: '*.example.com' } },
          { id: 'msal-terminal', match: { regex: '^https://login\\.microsoftonline\\.com/x' } },
        ],
      }),
    ).toEqual(['*.example.com', 'rule:msal-terminal']);
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
