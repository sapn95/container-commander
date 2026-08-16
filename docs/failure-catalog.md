# The failure catalogue

Seven failures, all observed in production on a real multi-identity Firefox
profile, most of them within one week. They are the reason this project exists
and they are the acceptance criteria: **every entry here is an executable
regression test**, and a design change that lets one of them return is a
regression whatever else it improves.

Hosts and identifiers are generalised — see [ADR-0011](adr/0011-employer-neutral-public-repo.md).
Three containers throughout: `personal`, `work`, `admin`, each holding a
_different_ account with the _same_ identity provider.

---

## F1 — The identity-provider yank

**Observed:** pinning the sign-in host (`login.example-idp.com`) to `work`.
A sign-in that began in `admin` was pulled into `work` mid-redirect. The
provider's test cookie was written in one jar and read from another, and the
error shown to the user was _"your browser is currently set to block cookies"_ —
which is not what happened and points nowhere near the cause.

**Why no rule can fix it:** all three identities sign in through that one host.
There is no correct fixed answer, so any fixed answer is wrong two thirds of the
time.

**The mechanism that prevents it:** rung 2. A redirect carries `originUrl`, so
it never reaches a rule at all. Additionally the compiler _refuses_ a bare pin
on any host listed in `authHosts`.

---

## F2 — The confirm-page arms race

**Observed:** a link clicked in an editor opened a GitHub URL. Multi-Account
Containers' confirm page took the navigation before linkward ever saw it.
linkward is the extension whose entire job is that link. It had no bug: it lost
a race whose ordering the platform does not define.

**Aggravating factor:** that dialog's _"Remember my decision for this site"_
does not remove the pin — it **moves** the pin to whichever container you chose
and silences it. The escape hatch deepens the hole.

**The mechanism that prevents it:** one router. Not a better-behaved second
router — no second router. Cooperating extensions announce claims to each other,
and the deterministic outside routes are seeded into linkward's never-ask list,
so the two blocking listeners are never both interested in one request.
See [ADR-0006](adr/0006-races-are-removed-by-configuration.md).

---

## F3 — Sync resurrection

**Observed:** an assignment was deleted, verified gone after a browser restart,
and was back two days later. It lives in **two** stores — the extension's local
IndexedDB _and_ the profile's sync database — and deleting one half is undone by
the other. Deleting both is still not enough: another machine re-uploads it
unless a _tombstone_ is written. During the verification of one cleanup, a third
machine pushed in a brand-new assignment.

**The mechanism that prevents it:** the extension has no writable rule store at
all. There is nothing to resurrect. See [ADR-0002](adr/0002-read-only-policy-via-managed-storage.md).

---

## F4 — The unroutable-by-host host

**Observed:** cloud console accounts existed in both `work` and `admin`. The
console hostname carries the **region**, not the account — the same string for
both. A host rule dragged every `admin` launch into `work`.

**Why no rule can fix it:** only the launcher knows which account an app belongs
to, because the launcher is the only party holding that mapping.

**The mechanism that prevents it:** rung 1. The launcher claims the tab before
creating it, and the compiler refuses any rule naming a host that a claim owns.

---

## F5 — Configuration drift

**Observed:** a rules file in a config repository is seeded into the browser
**once**; after first run the file is ignored. Repo and profile then drifted in
_both_ directions — rules in the repo that were never live, rules live that were
never in the repo — and neither was automatically the truth.

**The mechanism that prevents it:** managed storage. There is no seeding step;
the file _is_ the source, read at every extension start. See
[ADR-0002](adr/0002-read-only-policy-via-managed-storage.md).

---

## F6 — The federation endpoint

**Observed:** a regex rule scoped to `…/saml2` was believed to match one VPN
client's sign-in. `/saml2` is the tenant's federation endpoint for **every**
application. Each launcher-opened application was silently re-routed mid-flow.
The tab was closed and reopened before first paint, so the only evidence was a
console tab in the wrong container, signed into the wrong account, and no trace
of how it got there.

**The lesson, third time in one week:** narrowing a URL pattern does not turn it
into provenance. It only makes the eventual surprise rarer and harder to find.

**The mechanism that prevents it:** rung 2 again — the launcher's flow carries
an origin by then — plus rung 1, which settles it before any rule is consulted.

---

## F7 — Platform gaps that shape everything

Not a failure but the terrain, and every design decision that looks strange
traces back to one of these:

| Fact                                                             | Consequence                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Firefox never exposes "this link came from another application"  | provenance must be **claimed** by cooperating extensions or **inferred** at entry |
| `transitionType` exists only at `onCommitted`, after the request | the decision cannot be made from it in a blocking listener                        |
| `target="_blank"` implies `noopener` since Fx79                  | `openerTabId` is absent for ordinary link clicks                                  |
| A tab's container is immutable                                   | routing is always close-and-reopen — **POST data is lost**                        |
| Two blocking listeners have no defined order                     | the race in F2 is not winnable, only avoidable                                    |
| `storage.managed` is read once per extension start               | config staleness must be _shown_, not denied                                      |
| No extension can see which extension opened a tab                | the claim protocol is not a convenience, it is the only way                       |
