# ADR-0009 — A hand-chosen container is provenance and is never overridden

**Status:** accepted

## Decision

An entry navigation in an unclaimed tab whose `cookieStoreId` is already a
non-default container stops at rung 2. Passive hints are suppressed; internal
rules resolve to leave-alone. At most, an explicitly configured `to: 'ask'` rule
may still ask, with the tab's own container preselected.

## Why

"New Container Tab → admin", then typing an address, is the strongest provenance
signal the platform offers: a person said so, in this tab, just now. Silently
reopening that elsewhere is the same insult as F1 and would be reported as "it
ignores me", which would be accurate.

Found twice by the adversarial pass, from two directions — a mapped bookmark URL
and a pinned host — which is usually the sign that a rung is missing rather than
a case being unusual.

## Why nothing regresses

Fresh `firefox-default` entries keep every rule, and that is the actual use for
rules: you are in no container and something should be routed. This clause only
declines to overrule a choice already made.
