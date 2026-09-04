# Releasing Hydranium

We use [changesets](https://github.com/changesets/changesets) to drive
versioning and npm publish.

## Adding a changeset to a PR

After making changes that should land in a release:

```bash
npx changeset
```

The prompt asks:

- Which packages changed
- Major / minor / patch
- A one-line summary (becomes a CHANGELOG entry)

Commit the generated `.changeset/<random-name>.md` file with your PR.

If the change does not need a release (refactor, test-only, docs,
chore), use:

```bash
npx changeset --empty
```

Nothing in the repository enforces this: the CI workflow builds and runs
`npm run check`, and neither workflow inspects `.changeset/`. A PR that
lands with neither a changeset nor an empty marker therefore goes green
and simply ships unversioned — the change reaches `main`, no Version
Packages PR mentions it, and it is absent from every CHANGELOG. Treat
the empty marker as the deliberate act it is rather than a formality a
bot will remind you about.

## Versioning policy

`@hydranium/*` uses **fixed** versioning — all packages bump to the
same version on every release, and the intra-framework peer ranges are
rewritten in lockstep. Independent versioning can be revisited if the
release rhythm of individual packages diverges meaningfully.

**The release line starts at 1.0.0, not at a 0.x.** Under `fixed`
plus caret peer ranges a 0.x line cannot take a minor bump at all:
`^0.x` is minor-tight, so any minor takes every peered-on dependent out
of range, changesets escalates those dependents to `major`, and `fixed`
then harmonises the whole group upward — a `minor` changeset on a 0.1.0
baseline emits **1.0.0**. That run exits 0 and the generated CHANGELOGs
still say `Minor Changes`, so the wrong answer is indistinguishable
from the right one at every point a reviewer would look. 1.x is the
only regime where a minor stays a minor. Keep
`onlyUpdatePeerDependentsWhenOutOfRange: true` in
`.changeset/config.json`: it is what stops a non-patch bump escalating
its peer dependents, and its default is `false`.

**That option is experimental, and changesets reads it from one place
only** — nested inside `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`:

```json
{
  "___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
    "onlyUpdatePeerDependentsWhenOutOfRange": true
  }
}
```

Spelled at the top level instead it is not an error: the config schema
declares no `additionalProperties`, so nothing rejects the key and
changesets falls back to the `false` default. The escape hatch then
reads as enabled in the file and behaves as off in the run — the same
indistinguishable failure this section opened with, one layer down.

The consequence of the 1.x floor is that a plain `1.x` version number
cannot carry the alpha signal — `1.0.0` reads as stable to semver. Two
mechanisms carry it instead, and they are **not interchangeable**: a
dist-tag (§Dist-tags) for every release after the first, and a
PRERELEASE version (§Pre-release mode) for the first, which is the only
one a dist-tag cannot cover.

**The first published version is therefore `1.0.0-alpha.0`, not
`1.0.0`.** A dist-tag cannot make the first release safe, because
npmjs.org assigns `latest` to the first version of a new package
whatever `--tag` asks for — so `1.0.0` would sit on `latest` and a bare
`npm install @hydranium/core` would resolve it as a normal release. A
prerelease version fixes that at the source rather than at the tag: the
auto-assigned `latest` then points at something whose version string
says `alpha`, and a semver RANGE (`^1.0.0`, `*`) does not match a
prerelease at all, so a dependency range never picks it up by accident.

Every example app (`@hydranium/example-*`) is ignored in
`.changeset/config.json` — they are all `private` and none is published,
so the pattern is deliberately scope-wide rather than per-example.

## Pre-release mode — how `1.0.0-alpha.0` is produced

A prerelease version does not come from `--tag`; it comes from
changesets' **pre-release mode**. Before the first `changeset version`,
once:

```bash
npx changeset pre enter alpha
```

That writes `.changeset/pre.json`. From then on `changeset version`
emits `1.0.0-alpha.0`, then `1.0.0-alpha.1`, and so on, instead of
`1.0.0`. It is a one-time act on `main`, not something the release
workflow does per run — `pre.json` is committed and its presence *is*
the mode.

**`changeset publish --tag alpha` is incompatible with pre-release
mode and fails the release.** `publish` reads `pre.json` first and
refuses outright:

> Releasing under custom tag is not allowed in pre mode

— exiting non-zero, which fails the workflow at the publish step, after
`changeset version` has already rewritten every manifest. So
`release.yml`'s `publish:` must lose `--tag alpha` in the SAME change
that enters pre mode. It is not merely fatal but redundant: in pre mode
changesets derives the dist-tag from `pre.json` itself.

**Which tag each pre-mode publish actually gets** is worth knowing
before reading `npm dist-tag ls` and being surprised, because it is not
constant:

- The **first** publish of a package goes to `alpha` (changesets uses
  `pre.json`'s tag), and npmjs.org additionally assigns `latest` to it
  as the first version to exist. So `1.0.0-alpha.0` sits on both.
- **Every prerelease after that** goes to `latest` and *not* to
  `alpha`, deliberately: once a package has published versions and all
  of them are prereleases of this tag, changesets treats it as
  "no regular release yet" and points `latest` at the newest one so a
  bare `npm install` keeps working. `alpha` then stalls at
  `1.0.0-alpha.0` until a non-prerelease exists. It says so on stdout
  per package — *"is being published to latest rather than alpha
  because there has not been a regular release of it yet"*.

## Leaving pre-release mode

Staying in pre-release mode silently keeps **every** later release a
prerelease: nothing expires, and `changeset version` gives no more than
a warning banner. Leaving is two steps and the second is the one that
matters:

```bash
npx changeset pre exit    # flips .changeset/pre.json to mode "exit"
npx changeset version     # emits the stable version, DELETES pre.json
```

`pre exit` alone changes nothing about the next version — it only marks
the intent. The following `changeset version` is what drops the
`-alpha.N` suffix and removes `pre.json`, and only once that file is
gone does `publish` accept a `--tag` again. Do it as the same change
that restores `--tag alpha` to the workflow, or the first stable
release publishes with no tag decision at all.

Two smaller consequences of the mode, so they are not met as
surprises: snapshot releases are refused outright in pre mode, and
`changeset version` still runs with no pending changesets when the mode
is `exit` (that is how the suffix comes off).

Everything in these two sections is read out of the installed
`@changesets/cli`, **not measured** — measuring it means publishing,
and a published version cannot be recalled. Re-read the tool before
relying on it if the pin has moved.

## How releases ship

On merge to `main` the Release workflow (`.github/workflows/release.yml`)
installs, builds, and runs the **whole contributor gate** (`npm run
check`) in its own `Full gate` step. It then calls
`changesets/action`, pinned to a commit SHA rather than to the `v1`
tag — a mutable tag on a third-party action is a publish credential
handed to whoever can move it. The action:

1. If any `.changeset/*.md` files exist on `main`, opens (or updates)
   a **Version Packages** PR that bumps versions, regenerates
   CHANGELOGs, and removes the consumed changeset files.
2. When the Version Packages PR is merged to `main`, the action runs
   again — this time it sees no pending changesets, so it runs
   `npx changeset publish --tag alpha` to push the bumped packages to
   npm. The tag is not optional outside pre-release mode and is
   forbidden inside it; see below and §Pre-release mode.

The Version Packages PR is the human review checkpoint before
publish. Look at the diff: are the version bumps right, are the
CHANGELOG summaries accurate?

**The gate lives in `release.yml` and not in CI, deliberately.** Both
workflows fire on the same `push: main` with no dependency either way,
so they race and a red CI run cannot stop a publish. CI therefore
asserts the arrangement instead of supplying it: a
`Release workflow gates itself before publishing` step reads
`release.yml` and fails unless the `npm run check` step appears at a
lower line number than the `changesets/action` step, because a gate
after the publish is not a gate. A publish that has silently lost its
gate is indistinguishable from one that never had it until a bad
version is on the registry, which npm does not let you take back.

## Refresh the lockfile on the Version Packages PR

`changeset version` rewrites every `package.json` but does **not**
touch `package-lock.json`. Immediately after it the lockfile describes
versions that no longer exist anywhere, and nothing in the sequence
above puts that right — so a Version Packages PR merged as-opened
commits a lockfile pinning versions the registry will never serve. The
mismatch is invisible until someone installs from it.

Before approving the PR, check out its branch and run:

```bash
npm install
git commit -m "chore(release): refresh the lockfile" -- package-lock.json
```

`npm install` and not `npm ci`: `ci` installs *from* the lockfile and
would fail on exactly the mismatch you are fixing.

It can be automated by appending an install to the workflow's
`version:` command, which runs before the PR is opened and so lands the
refreshed lockfile in the same diff. Until that happens it is a review
step, and skipping it ships a broken install.

## Dist-tags — where the alpha signal lives

`npm publish` writes the `latest` tag unless told otherwise, and
`latest` is what a bare `npm install @hydranium/core` resolves. So an
alpha release has to name its tag at publish time:

```bash
npx changeset publish --tag alpha
```

`changeset publish` forwards `--tag` to `npm publish`, which makes the
workflow's `publish:` command the single place the tag is decided.
Leave it off and the alpha lands on `latest`, which is exactly what the
tag exists to prevent.

**`release.yml`'s `publish:` carries the flag** — it reads `npx
changeset publish --tag alpha`, and the flag is a prerequisite of the
first publish rather than a refinement after it. Leaving it off is not
"no tag": `changeset publish` always forwards a `--tag` to `npm
publish` and defaults it to `latest`, so the alpha would become what a
bare `npm install @hydranium/core` resolves, with semver reading 1.0.0
as stable. A dist-tag can be moved later; a version that has already
been served from `latest` cannot be recalled. Drop the flag only in the
same change that moves `latest` deliberately.

**The flag and pre-release mode are mutually exclusive**, and the
first release is a pre-release-mode release — see §Pre-release mode.
`changeset publish` refuses a custom tag while `.changeset/pre.json`
exists, so entering pre mode and leaving `--tag alpha` in the
workflow's `publish:` fails the release at the publish step. The flag
comes off when the mode goes on and back on when the mode comes off;
the paragraph above describes the checked-in state, which is the
correct state for a release that is NOT in pre mode.

Two things to do rather than assume:

- **The first publish also takes `latest`, whatever the tag says.**
  npmjs.org assigns `latest` to the first version of a new package in
  addition to the requested tag — changesets' own publish code says so
  beside the `only-pre` detection that depends on it, and no workflow
  line can prevent it. That is precisely why the first version is a
  prerelease: `latest` will point at `1.0.0-alpha.0`, whose version
  string says what it is and which no semver range matches. Confirm
  with `npm dist-tag ls @hydranium/core` straight after the first
  publish.
- **Move `latest` deliberately when the framework goes stable** — `npm
  dist-tag add @hydranium/core@<version> latest`, per package. A
  dist-tag is mutable where a published version is permanent, which is
  the whole reason the signal lives in the tag.

## Provenance

The release workflow publishes with npm provenance: `permissions:
id-token: write` plus `NPM_CONFIG_PROVENANCE: true`, which makes npm
mint a signed attestation binding each tarball to the workflow run and
the commit that built it.

Both halves are required and they fail differently, which is why they
are worth naming separately. Drop the `id-token: write` permission and
npm **fails** the publish with an explicit provenance error, so that
half cannot rot unnoticed. Drop `NPM_CONFIG_PROVENANCE` and npm
publishes normally and simply attaches nothing — a tarball with no
attestation is indistinguishable at the command line from one that has
it. That is why a release is never published by hand: a local `npm
publish` has neither half and looks entirely successful. Confirm
provenance on the registry page, not from a green workflow run.

## Prerequisite (one-time)

Set the `NPM_TOKEN` repo secret to an npm automation token with
publish rights to the `@hydranium` scope.

## Migration note

Previously the project used `lerna version` + `lerna publish` with
conventional-commit parsing. That ran on every merge to `main`,
which over-versioned cosmetic commits. Changesets makes the version
intent explicit per PR.
