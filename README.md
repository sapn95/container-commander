# container-commander

**One thing decides which Firefox container a tab opens in — once, at the
moment the tab is born, and never again.**

Firefox containers are excellent and their tooling fights itself. Run
Multi-Account Containers, Containerise and Folder Containers together and you
have three engines answering the same question from three different files, none
of which can see who asked. Add an app launcher and a link handler of your own
and you have five. They do not merge; they race, and the tie-break is a dialog
asking you to settle it by hand.

container-commander is the arbiter that makes the question have one answer.

> **Status: design and specification.** The architecture below survived a
> three-way design panel, two judges and four adversarial passes that found
> twenty-one breaks — every one of which is repaired here. The tests are being
> written first. There is no implementation yet, and that is deliberate.

## The one idea

**A container is a property of a flow, not of a URL.**

Every failure in [the catalog](docs/failure-catalog.md) is the same mistake in
a different costume: a rule that matches a _URL_ was allowed to act on a _flow_
that was already under way. A sign-in host is shared by three identities. A
federation endpoint is shared by every application in a tenant. A cloud console
hostname carries the region, not the account. No pattern over those strings can
answer "which identity is this", because the string genuinely does not know.

So the decision happens **exactly once, at a flow's first request**, from the
best provenance available — and after that the flow is inherited, untouchable,
to the end.

## The ladder

```
GATE 0  Scope        main_frame, http(s), GET, first navigation of a fresh tab.
                     Anything else is not ours. Never asks, never reopens.
RUNG 1  Claims       A cooperating extension said "this tab is mine" BEFORE it
                     created it. Outranks every rule, including deterministic ones.
RUNG 2  Inheritance  originUrl/documentUrl present, an opener, a non-default
                     container chosen by hand → leave alone without reading config.
                     This rung IS "auth follows caller".
RUNG 3  Entry shape  What survives is an entry. External-shaped or internal-shaped,
                     with an ambiguity band that resolves to silence.
RUNG 4  Entry rules  First match over a compiler-ordered list. External rules for
                     outside hand-offs, internal rules for in-browser entries.
RUNG 5  Ask          Only when a rule says so. Never a fallback.
RUNG 6  Leave alone  A named rung, not an else-branch. Every unknown lands here.
        ─────────────
OUT     Human override — "Reopen this tab in <container>", on an explicit gesture.
        The only path by which a rule may touch a flow that already exists.
```

Read it in full in [docs/architecture.md](docs/architecture.md); the reasoning
per decision is in [docs/adr/](docs/adr/).

## What it is not

- **Not a router that knows better.** Unknown, ambiguous, or broken config all
  land on rung 6 and the extension behaves as if it were not installed.
- **Not a writable rule store.** Policy is read-only, delivered by
  `storage.managed` from a file your config repo generates. "Remember" is
  session-scoped plus a snippet you paste into that repo. Nothing the extension
  can write can outlive the browser — that is what makes drift impossible.
- **Not live.** Firefox reads a managed manifest once per extension start. The
  popup shows the loaded revision and its age rather than pretending otherwise.
- **Not a prompt.** For links arriving from outside the browser, asking belongs
  to [linkward](https://github.com/sapn95/linkward). The compiler refuses a
  config that would give commander a second prompt on the same territory.
- **Not Chromium.** Containers are a Firefox feature.

## Repository layout

|                           |                                                            |
| ------------------------- | ---------------------------------------------------------- |
| `docs/architecture.md`    | the full design, post-adversarial                          |
| `docs/failure-catalog.md` | the seven observed failures, each an executable regression |
| `docs/adr/`               | one file per decision a reviewer would question            |
| `docs/protocol.md`        | the four-message claim protocol                            |
| `tests/`                  | the specification, as failing tests                        |
| `src/lib/engine.js`       | the pure core — does not exist yet, by design              |

## Licence

MIT.
