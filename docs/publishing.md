# Publishing

One store, unlike the two sibling extensions: containers are a Firefox feature,
so there is no Chrome half and no lockstep to keep between two review queues.

## What only a human can do

**One thing**, and it takes about a minute.

The first upload creates the listing _and_ the version through the API, as long
as the package carries what AMO refuses to take from the manifest — `categories`,
`summary` and `version.license`. All three, plus the description, homepage,
support link and reviewer notes, are in
[`docs/store/amo-metadata.json`](store/amo-metadata.json). There is **no form to
fill in by hand**.

> AMO reports a missing field **one per attempt**, so each omission would cost a
> round trip. That is why the file is fuller than the minimum.

The listing **icon and screenshots** are not in the package either, and AMO does
not read them from it — with no icon uploaded, a signed and reviewed add-on sits
in the store behind Mozilla's grey placeholder. `web-ext sign` cannot upload
either one, so the release workflow runs
[`scripts/amo-art.mjs`](../scripts/amo-art.mjs) in a step of its own after
signing. Nothing to do by hand there either.

### Put the API key in the repository

<https://addons.mozilla.org/developers/addon/api/key/> → two values:

| Secret           |                   |
| ---------------- | ----------------- |
| `AMO_JWT_ISSUER` | the issuer string |
| `AMO_JWT_SECRET` | the secret        |

```bash
gh secret set AMO_JWT_ISSUER --repo sapn95/container-commander
gh secret set AMO_JWT_SECRET --repo sapn95/container-commander
```

Until both are set the release workflow **skips the publish and says so** rather
than failing: a missing key is a setup step, not a broken build.

## Releasing

`Actions → Release → Run workflow`, with `tag` empty.

The bump comes from the commit subjects: a `!` or `BREAKING CHANGE` is major,
any `feat` is minor, everything else a patch.

> ⚠️ **The PR title becomes the squash commit subject**, and that subject is
> what the bump is computed from. A pull request titled "Fix the thing" produces
> a patch even when its commits say `feat:`. Put the prefix in the PR title.

`main` is protected, so the workflow does not push to it. It pushes a
`release/vX.Y.Z` branch, opens a pull request, approves its own held runs, waits
for the checks, squash-merges, and tags the commit that actually landed — a
squash rewrites the commit, so a tag made before the merge would name a SHA that
never reaches `main`.

## The listing art

`npm run amo:art`, run by the release workflow immediately after the sign step.

It is also the recovery path, and it is safe to run by hand. Every run
replaces the whole set rather than adding to it, so a sync that stopped —
because AMO was read-only, because the add-on did not exist yet, or because a
request timed out — is finished by running it again with the credentials in the
environment. There is nothing to undo first.
It uploads `dist/icons/icon-128.png` as the listing icon and every numbered PNG
in [`docs/store/`](store/) — `01-*.png`, `02-*.png`, … — as the screenshots, in
filename order.

It is **declarative**: each run deletes the previews that are on the listing and
re-posts the whole set. Running it twice leaves the listing identical and
accumulates nothing.

Three things about that API each cost an afternoon, so they are written down
here rather than rediscovered.

- **There is no image replace.** `PATCH .../previews/<id>/` accepts a new image,
  answers `200` — and keeps the old one. Only the caption and the position are
  writable after creation. Replacing a screenshot is DELETE then POST, which is
  why the step wipes before it uploads instead of editing in place. Reading the
  current set is a third quirk: `GET` on the previews collection is a `405`, so
  the existing previews come off `previews[]` on the add-on detail.
- **The declared part type is what gets validated**, not the bytes. A bare
  `Buffer` appended to a `FormData` goes out as `application/octet-stream`, and
  a perfectly good PNG comes back as _"Images must be either PNG or JPG."_ Wrap
  it: `new Blob([buf], { type: 'image/png' })`.
- **Uploads are paced about 21 seconds apart.** Preview create and delete count
  against the same add-on submission throttle as the version upload that
  `web-ext sign` made minutes earlier — 3 a minute, 10 an hour — and a naive
  loop `429`s on its fourth call.

> The old note here said the API would not take a screenshot. It does; it will
> not take one _while creating the add-on_, because that request is already
> multipart (it carries the XPI) and form data has no way to nest the `version`
> object inside it. Screenshots are simply a second call.

Size: AMO stores a preview at up to 2400×1800, downscaling anything larger and
never upscaling anything smaller — so a bigger source is fine and simply lands
smaller. The 2560×1600 we ship becomes 2400×1500. Its gallery card is 320×200,
so 1.6:1 fills the card and 4:3 letterboxes it. There is no minimum and no ratio rule on
the API path — the 1000×750 check belongs to the devhub form, which this never
touches.

## The policy file is not part of the release

Worth being explicit, because it is the whole design: **this repository ships no
rules.** The extension is an interpreter, and the policy arrives separately, on
each machine, at:

```text
~/Library/Application Support/Mozilla/ManagedStorage/container-commander@sapn95.github.io.json
```

That file is generated by a **private** config repository — see
[ADR-0002](adr/0002-read-only-policy-via-managed-storage.md) — and never appears
here. A release therefore cannot change anybody's routing, and a policy change
needs no release. That separation is the point.

## When a release does not publish

| Message                           | Meaning                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AMO secrets incomplete`          | The two secrets are not both set. Nothing was uploaded; nothing is broken.                                                                                     |
| `version already exists`          | That version number is already on AMO. Bump and re-run.                                                                                                        |
| a validation error naming a field | AMO wants another key in `amo-metadata.json`. It reports one per attempt, so add it and re-run.                                                                |
| `No add-on on AMO under this id`  | The art step ran before a listing existed. The next release uploads it.                                                                                        |
| `AMO is read-only right now`      | Mozilla is mid-deploy or mid-incident. The version published; the art follows next release.                                                                    |
| `AMO uploads are switched off`    | The same, as a `503` from an upload rather than up front. If it lands between the wipe and the re-post, the listing has no screenshots until the next release. |

A listed add-on is reviewed by Mozilla, which takes hours to days. The workflow
does **not** wait for approval (`--approval-timeout=0`): waiting would time out
after fifteen minutes and turn a perfectly good release red.
