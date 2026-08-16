# ADR-0007 — The verifier runs the shipped engine, pinned to the installed release

**Status:** accepted

## Decision

The config repo consumes this repo as a locked dependency **at the installed
release tag**, not at `HEAD`. `check.mjs` asserts `engine.VERSION === pin` as its
first test. The pin moves in a dedicated commit, after the matching release is
confirmed installed.

## Why

A verifier that reimplements the engine drifts from it — the existing config
repo already carries a hand-written reimplementation of another add-on's
matching algorithm, which is a standing bet that two pieces of code stay
identical by care alone.

Running the shipped engine fixes the logic drift. But "one engine in both
places" is only true _per revision_: verifying against `HEAD` while the browser
runs last month's release is a green check for code nobody is executing.

## The residual, and what we do about it

The engine's **input** is still assembled by two different pieces of code — the
background page in the browser, the fixture builder in the verifier. That is
where the next silent divergence would live.

So fixtures are **harvested from reality**: the decision ring buffer records the
full assembled input beside each Decision, and the popup exports them as
`check.mjs` cases. Fixtures you guessed agree with the code that guessed them;
fixtures you recorded do not.
