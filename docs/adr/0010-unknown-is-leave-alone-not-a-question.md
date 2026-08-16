# ADR-0010 — Unknown is leave-alone, never a question

**Status:** accepted

## Decision

Rung 6 is a named terminal rung with its own log reason. Everything unmatched,
ambiguous, unresolvable, or erroring lands there. Asking is reachable **only**
from an explicit `to: 'ask'`.

## Why

An extension that asks when it is unsure teaches you to dismiss it, and a prompt
dismissed by reflex is worse than no prompt: it is a prompt that will be
dismissed the one time it mattered.

The inherited quality bar from linkward: when in doubt, behave as if not
installed. A wrong silence costs one link opening where it always used to. A
wrong question costs trust, several times a day.

This is also why the shape-ambiguity band resolves downward — in the disagreement
zone between two extensions, both are silent.
