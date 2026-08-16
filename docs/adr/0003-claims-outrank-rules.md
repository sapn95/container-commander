# ADR-0003 — Claims outrank every rule, including deterministic ones

**Status:** accepted

## Decision

Rung 1 (a claim from a cooperating extension) beats rung 4 (entry rules). The
compiler refuses any rule naming a host that a claim owns.

## Why

F4: cloud console accounts exist in two containers, and the hostname carries the
_region_, not the account. No URL pattern can separate them. The launcher is the
only party that knows, because it holds the app-to-account mapping.

Whenever a claim and a rule disagree, the claim holds strictly more information:
it was made by the code that _caused_ the navigation. A rule is a guess made
earlier by someone who could not see this moment.

## Consequence

A lost claim degrades to **leave-alone**, never to a rule. That is correct: if
the claim was lost, the launcher has already placed the tab itself, and second-
guessing it is F4 again.
