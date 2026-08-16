# ADR-0006 — Races are removed by configuration, not won by ordering

**Status:** accepted

## Decision

Where two blocking listeners could both be interested in a request, we remove
the overlap by configuration — claim directionality, never-ask seeding, disjoint
jurisdictions, and a revision handshake — rather than trying to act first.

## Why

Firefox's only documented semantics for multiple blocking handlers is that when
several modify a request, one set of modifications wins; ordering across
extensions is effectively registration order, which is startup order, which is
not stable and not ours to control.

F2 was linkward losing exactly this race. It had no bug. It cannot be fixed by
being faster, because "faster" is not a thing the platform lets us be.

## The mechanisms

1. **Claim directionality** — including commander announcing every tab _it_
   creates to linkward, so its own reopened tab is never mistaken for a fresh
   external link (an adversarial finding).
2. **Never-ask seeding** — deterministic external routes enter linkward's
   never-ask list, so its listener declines them.
3. **The ambiguity band** — commander only calls an entry internal-shaped at
   twice the focus grace period; the band in between resolves to silence in both
   extensions.
4. **The revision handshake** — `cc:ping` carries the loaded config revision; a
   mismatch drops external enforcement to leave-alone with a visible badge,
   because two extensions running two revisions of one jurisdiction fact is F2
   with better manners.
