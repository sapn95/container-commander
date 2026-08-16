# ADR-0008 — Bookmark hints are the weakest tier, and cannot open a side door

**Status:** accepted

## Decision

Three unequal tiers: the context-menu launcher (deterministic), the passive hint
on an internal entry (weakest), the picker preselect (cosmetic). `never[]` and
`authHosts[]` filter hints **before** ranking. One canonical index, no live
search fallback.

## Why

A bookmark filed in a mapped folder is weak evidence: it says where you once
filed a URL, not where this navigation belongs. Given equal standing with a
rule, it becomes a side door — a console deep-link or a bare sign-in URL sitting
in a work folder would silently route into the wrong account, which is F4 and F1
arriving through the bookmarks tree (both found by the adversarial pass).

The launcher stays exempt because it is a **human gesture**, the same doctrine
that exempts the out-of-ladder reopen command.

## Why one index and no search

A live `bookmarks.search()` fallback disagrees with a maintained index about
trailing slashes, fragments, `www`, and scheme. Two mechanisms, two answers, and
irreproducible bug reports. So: one index, canonical keys, and any collision
across differently-mapped folders is a conflict handled like any other.

## Why it is awaited in the blocking handler

Built behind a memoised promise and awaited. Otherwise the first bookmark opened
after the event page idles out routes differently from the second — the exact
class of bug that cannot be reproduced on demand.

## Folder paths, not ids

Bookmark ids are per profile. A config keyed by them is a config that only works
on the machine that wrote it, which is F5 wearing a different hat.
