# ADR-0005 — POST requests are never reopened

**Status:** accepted

## Decision

GATE 0 refuses any request whose method is not `GET`. Refusals are logged, not
silently dropped.

## Why

Reopening is close-and-create. `tabs.create` accepts a URL and nothing else, so
the replayed navigation is a fresh GET: **the body is gone**. Verified as a
platform limitation, not an implementation gap.

Losing a form submission to a container router is a worse outcome than any
routing mistake it could have prevented. The user typed that.

## Why it is logged

A deterministic route silently not firing is indistinguishable from a broken
config. F6 taught that silent correctness is only correctness if you can see it.
