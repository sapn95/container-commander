# ADR-0011 — The public repo carries no employer identifiers, enforced by an allowlist

**Status:** accepted

## Decision

Real hostnames, tenant identifiers and client ids live **only** in the private
config repo. CI in the public repo enforces an **allowlist**: a permitted dummy
vocabulary (`example.com`, `example-corp.com`, documented generic vendor hosts,
all-zero dummy GUIDs, loopback) and it fails on any other hostname-shaped or
GUID-shaped token anywhere — fixtures, test names, comments, documentation.

## Why an allowlist and not a denylist

A denylist of forbidden strings is itself a list of the things you are hiding.
It has to be updated by the person who is about to leak something new, and it
fails open on everything nobody thought of.

An allowlist contains no secrets by construction and fails **closed**. That was
an adversarial finding, and it is the whole reason this ADR exists rather than a
line in a contributing guide.

## Consequence

The failure catalogue in this repo is generalised: three containers named
`personal`/`work`/`admin`, one `login.example-idp.com`, no real tenants. The
failures are entirely real; the identifiers are not.
