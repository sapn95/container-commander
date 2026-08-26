# Privacy

container commander has no server, no account and no analytics. Nothing it sees
leaves your machine, and there is nowhere for it to go: the extension makes no
network requests of its own at all.

## What it looks at

While the feature is switched on, it sees the **address of a page about to open
in a newly created tab**, and only long enough to decide which container that
tab belongs in.

It looks at nothing else. No page content, no form data, no cookies, no
credentials, no history. It does not read the pages you are already on.

## What it stores

|                                   |                                                                    |
| --------------------------------- | ------------------------------------------------------------------ |
| **The policy**                    | read-only, from managed storage. The extension cannot write to it. |
| **The last 50 decisions**         | in memory, for the popup's log. Gone when the browser closes.      |
| **A pause switch**                | session storage. Gone when the browser closes.                     |
| **Which window was last focused** | session storage, as a timestamp. Gone when the browser closes.     |

That is the complete list. There is deliberately **no writable rule store** —
not because storage is expensive, but because a store that can be written can
drift from its source and come back after you delete it, which is a failure this
add-on was written in response to.

## What it sends

Nothing.

Two exceptions, both local and both to software you installed yourself: it can
exchange short messages with [linkward](https://github.com/sapn95/linkward) and
[beeline](https://github.com/sapn95/beeline) — the two extensions it cooperates
with — so that none of them acts on a tab another one has already placed. Those
messages carry a URL and a container id, they never leave the browser, and the
recipients are a fixed list of two extension ids that cannot be extended without
a new release.

## The permissions, and why

| Permission                                       | Why                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<all_urls>`, `webRequest`, `webRequestBlocking` | **Optional and requested at runtime**, never at install. Holding a top-level navigation in a new tab is the only way to place it in a container before anything is fetched — a container cannot be changed afterwards. Switching the feature off hands them back. |
| `contextualIdentities`, `cookies`                | Reading your containers' names, and opening a tab in one.                                                                                                                                                                                                         |
| `bookmarks`                                      | Only to look up which mapped folder a bookmarked address is filed in, and only if you configure bookmark folders. It never reads a bookmark you have not mapped.                                                                                                  |
| `storage`                                        | Session state, as listed above.                                                                                                                                                                                                                                   |
| `menus`                                          | The "Reopen this tab in …" command.                                                                                                                                                                                                                               |
| `activeTab`                                      | The address of the tab you are looking at, and only while you have the toolbar panel open. It is what lets "move this tab" work on a profile that never granted the watching permission above.                                                                    |

## Reading the code

All of it, in one place, unminified: <https://github.com/sapn95/container-commander>

There is no build step. The source under `src/` is exactly what is packaged —
`scripts/build.mjs` copies it and stamps the version into the manifest, and that
is the whole of it. No bundler, no minifier, no runtime dependencies.
