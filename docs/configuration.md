# Configuring it

container commander ships **no rules**. A fresh install decides nothing, moves
nothing and looks exactly like an add-on that is not working — which is the
intended behaviour and the reason this page exists.

You give it a policy by writing one file. There is no settings screen, and there
is deliberately no way for the add-on to write a rule of its own: a store the
extension can write to is a store that drifts from wherever it came from, and
comes back after you delete it.

## 1. Where the file goes

The name of the file **is** the extension id. That is what makes Firefox hand it
to this add-on and not another.

|             |                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | `~/Library/Application Support/Mozilla/ManagedStorage/container-commander@sapn95.github.io.json`                                                                  |
| **Linux**   | `~/.mozilla/managed-storage/container-commander@sapn95.github.io.json`                                                                                            |
| **Windows** | A registry key `HKEY_CURRENT_USER\Software\Mozilla\ManagedStorage\container-commander@sapn95.github.io` whose default value is the full path to your `.json` file |

Create the folder if it is not there. The add-on's own page shows the path for
the machine you are on, with a button to copy it.

Firefox also reads the system-wide locations (`/Library/...`, `/etc/firefox/...`,
`HKEY_LOCAL_MACHINE`). Use those only if you are deploying this to other people.

## 2. What to put in it

The outer three fields are Firefox's native-manifest wrapper; everything you
care about is under `data.policy`.

```json
{
  "name": "container-commander@sapn95.github.io",
  "description": "container commander policy",
  "type": "storage",
  "data": {
    "policy": {
      "schema": 1,
      "revision": "hand-written-1",
      "dryRun": true,
      "rules": [
        { "id": "example", "scope": "any", "match": { "host": "example.com" }, "to": "Work" }
      ]
    }
  }
}
```

`"to"` is a container **name**, exactly as it appears in Firefox's container
list — not `firefox-container-2`. Names are resolved when the rule fires, so a
name that does not exist leaves the tab alone and says so in the log rather than
guessing.

Leave `dryRun` on at first. It decides everything and moves nothing, and the
add-on's page lists what it would have done. Turn it off when the list stops
surprising you.

## 3. Make it live

Managed storage is read **once, when the add-on starts** — not when you save the
file. Press **Reload policy** on the add-on's page. Restarting Firefox does the
same thing more slowly.

If the policy loaded, the page shows the `revision` string you wrote and a rule
count. If it did not, it says why.

## The rest of the format

| Field               |                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`            | `1`. The only version there is.                                                                                                              |
| `revision`          | Any string. It is shown on the add-on's page, and it is how you tell which edit is live — so make it say something, like a date or a commit. |
| `dryRun`            | `true` decides but never moves a tab.                                                                                                        |
| `rules`             | In order. **First match wins**, so put the specific ones first.                                                                              |
| `never`             | Hosts no rule may ever act on.                                                                                                               |
| `authHosts`         | Sign-in hosts. A rule that pins one of these by bare hostname is refused — see below.                                                        |
| `bookmarks.folders` | Map a bookmark folder path to a container. The weakest signal there is; it only applies to entries begun inside the browser.                 |

### A rule

```json
{
  "id": "unique-and-yours",
  "scope": "any",
  "match": { "host": "example.com" },
  "to": "Work"
}
```

- **`id`** — anything, as long as it is unique. It appears in the log.
- **`scope`** — `any` is what an ordinary host rule means: the site belongs in
  that container whether you typed its address or a colleague sent you a link.
  `external` is for links handed to Firefox from another application.
  `internal` is for navigations that began inside the browser, and it is the
  only scope allowed to `ask`.
- **`match`** — either `{ "host": "..." }` or `{ "regex": "..." }`. A host match
  covers subdomains; a regex is matched against the whole URL.
- **`to`** — a container name, or `"ask"` to be offered a choice.

### What the compiler will not let you do

These are refused with a message rather than accepted quietly, because each one
is a way to make sign-in break in a manner that reports itself as something
else:

- **A bare pin on an auth host.** a federation endpoint like
  `login.example-idp.com` is shared by every identity you own; a rule that sends the hostname to one container will pull
  somebody else's sign-in into it halfway through. Scope it by path or regex.
- **`ask` on an external rule.** Asking about links from outside the browser
  belongs to [linkward](https://github.com/sapn95/linkward). Two add-ons
  prompting for the same click is the problem this one was built to end.
- **A rule on a host a launcher claims.** A claim outranks every rule, so such a
  rule would silently never fire.

## Checking a policy before you install it

```sh
npm run policy:check path/to/file.json
```

It uses the extension's **own** `validateConfig` and `compile` — the same
functions the browser runs — so a file it accepts is a file that loads, and the
order it prints is the order that will be evaluated. It takes either the
wrapper or a bare policy, and says which one it found: a bare policy saved to
the managed path is ignored by Firefox without a word.

That also makes it the thing to point an assistant at. The format is small
enough to write from this page, and `policy:check` is how the writing gets
verified rather than assumed.

## More than one source

One file is fine until two things generate it. Work rules from a config
repository and personal rules written by hand cannot share a file without one
overwriting the other every time either is regenerated — and the loser is
silent, because a policy that has lost half its rules is still a valid policy.

So the source can be a directory:

```
~/.config/container-commander/
  10-work.json        generated by a config repo
  20-personal.json    written by hand
```

```sh
npm run policy:build            # print what would be installed
npm run policy:build -- --apply # write it
```

The numbers are the merge order. They decide nothing about rule PRECEDENCE —
the compiler sorts by specificity — but they do decide who wins a scalar.

What the merge does, and why:

|                      |                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules`              | all of them, from every file. A **duplicate id is refused**, naming both files: it means two files believe they own the rule, and silently keeping one is how a rule disappears from a policy nobody edited.                                                           |
| `never`, `authHosts` | **unioned**, never last-one-wins. A host coming _off_ the never list is the failure that made the list exist.                                                                                                                                                          |
| `dryRun`             | on if **any** fragment asks for it. Enforcing because the other file forgot to mention it is the wrong way round.                                                                                                                                                      |
| everything else      | the last file that sets it.                                                                                                                                                                                                                                            |
| `revision`           | derived from the file names and their contents. It identifies the **inputs**, because the only question it has to answer is "is what I edited what is running" — a timestamp answers "when was it built", which looks identical on screen and is a different question. |

A fragment may be a bare policy or a full native-manifest wrapper, so a file
that already works on its own can be dropped in unchanged.

## Building one without writing JSON

The add-on's page has a **rule builder**. It composes the file — validating each
addition against the whole policy with the shipped validator, and showing where
your rule lands in the compiled order — and then hands you the finished bytes.

It has no save button, and that is the feature rather than a missing half. See
the section above on why there is no writable rule store.

## Generating it instead of writing it

Once there is more than a handful of rules, a hand-written JSON file is a thing
that drifts. The way this is used in practice is a small config repository that
holds the rules in a readable form, compiles them to this file, and runs every
rule through the extension's **own** `decide()` before installing it — so the
check cannot disagree with the browser.

That is roughly a hundred lines. The shape:

```
policy.yaml      the rules, readable
compile.mjs      policy.yaml -> the managed-storage file
check.mjs        imports the extension's decide(), asserts each case
```

Pinning the extension as a git submodule is what keeps `check.mjs` honest: a
verifier that reimplements the engine is a green tick for code nobody is
running.

## When it does nothing

That is the design, so work down this list before assuming it is broken:

1. **No policy.** The add-on's page says so, with the path.
2. **`dryRun` is on.** It is deciding; look at the decision list.
3. **The tab was not an entry.** A link clicked inside a page, a redirect, or a
   tab you had already put somewhere is left alone on purpose — the container
   is a property of the flow, and that flow already had one.
4. **Something else claimed it.** A cooperating launcher can say "this tab is
   mine" before it creates it, and that outranks every rule.
5. **The container name does not resolve.** Check the spelling against Firefox's
   own list.

Every one of those appears in the decision list with a named reason. The list is
the product: it accounts for the decisions to do nothing as well as the ones
that moved something.

For **why** it is built this way — why once, why not live, why no writable
store — read [architecture.md](architecture.md) and the
[failure catalog](failure-catalog.md).
