# ADR-0004 — Commander never prompts on external entries

**Status:** accepted

## Decision

Commander has no prompt surface for links arriving from outside the browser.
Only a rule scoped `internal` may ask: the compiler refuses `to: 'ask'` on both
`external` and `any` — `any` includes outside links — and the engine refuses it
again at rung 4. That territory belongs to linkward.

## Why

F2 is two extensions wanting the same navigation, with no defined ordering
between blocking listeners. It is not winnable — only avoidable. Two pickers on
one territory would be F2 rebuilt deliberately, out of our own parts.

Making it a **compiler refusal** rather than a convention matters: a convention
is a comment someone will edit past at 23:00 while fixing something else.

## Consequence

Deterministic external routes (VPN sign-in, terminal sign-in) resolve silently
in commander, and are seeded into linkward's never-ask list so its blocking
listener is not interested in them either. Neither extension asks; exactly one
acts.
