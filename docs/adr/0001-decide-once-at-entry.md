# ADR-0001 — Decide once, at entry, and never again

**Status:** accepted

## Decision

A tab's container is decided at the first request of a flow. After that the flow
is inherited and untouchable. No mid-flow correction exists, in any form.

## Why

Every failure in the catalogue is a rule that matched a URL acting on a flow
already under way. F1 (identity-provider yank), F4 (unroutable host) and F6
(federation endpoint) are the same bug found three times in one week, each time
after the previous URL pattern had been made "narrower and safer".

Narrowing a pattern does not turn it into provenance. It makes the surprise
rarer and correspondingly harder to diagnose — F6 hid for two days because the
tab was closed and reopened before first paint and left no trace.

There is also a hard platform reason: a tab's container is immutable, so every
"correction" is close-and-reopen, which **loses POST data**. A design that
corrects mid-flow is a design that eats form submissions.

## Alternatives rejected

- **Re-route on `onCommitted` using `transitionType`.** It is the only place the
  browser says how a navigation started — and it says so after the request has
  gone. Acting on it is F6 with better information and the same outcome.
- **Narrower regexes.** Tried three times. See above.
