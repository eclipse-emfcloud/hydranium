# Releasing Hydranium

A push to `main` that can change a published tarball publishes. There is no
release ceremony, no version commit and no approval step between a merged PR
and a version on npm, because the version number is **derived**, never written
down.

## The version

Each release is `<base>.<n>`, where `n` counts the commits since the last
release tag. The base is a `-next` prerelease committed as `version` in the
root manifest and in every package manifest; `scripts/release.mts` appends
`.<n>` in the runner's tree, and it is never committed.

The line starts at major one, and that is not a stability claim. Under `fixed`
versioning with caret peer ranges, a zero-major line could not take a minor
bump at all, so the prerelease suffix carries the alpha signal instead. A minor
bump may break the API for as long as the framework is alpha.

Three properties follow, and each is load-bearing:

- **It is monotonic.** A commit hash is not: a short SHA is sometimes all
  digits, semver sorts an all-numeric prerelease identifier *below* every
  alphanumeric one, and one with a leading zero is not valid semver at all, so
  such a release would sort behind its predecessor or fail to publish.
- **No range matches it.** A caret range on a stable version resolves no
  prerelease, so a consumer has to ask for the version, or for a dist-tag.
- **The stable release sorts above all of it.** `X.Y.Z-next.<n>` sorts below
  `X.Y.Z` for every `n`, so cutting the stable version is a clean upgrade from
  every prerelease before it.

The counter counts commits, not releases, so a push that does not publish
leaves a gap in `n`. That is expected, not a lost release.

All packages publish **in lockstep** at one version, with intra-framework
ranges rewritten to it **exactly**. A caret on a prerelease also matches the
stable versions above it in the same major, so it would let a consumer of one
package resolve a sibling from a future stable line. The set that publishes is
the set that was built together.

## Dist-tags

**Until the first stable release, every prerelease publishes to `latest`.** npm
assigns `latest` to the first version of a new package whatever `--tag` asks
for, so publishing only to `next` would strand `latest` on the very first
prerelease and a bare `npm install @hydranium/core` would resolve it forever.
Moving the tag afterwards would need `npm dist-tag add`, which cannot
authenticate over OIDC ([npm/cli#8547][8547]), so it would mean keeping a
long-lived token for that one call. After the first stable release, `latest`
belongs to the stable line and the rolling line moves to `next`.

`scripts/release.mts` **derives** which applies by asking the registry whether
any non-prerelease version exists, rather than reading a flag someone has to
remember to flip on the day it stops being true.

[8547]: https://github.com/npm/cli/issues/8547

## How a release runs

`.github/workflows/release.yml` runs on every push to `main` and on
`workflow_dispatch`, in three jobs:

- **`changes`** classifies the pushed range with `scripts/release-changed.mts`
  and skips the other two jobs when every changed path is on that script's
  skip list of paths that reach no tarball. Anything else publishes, and so
  does a dispatch or a range whose base does not resolve: an over-trigger costs
  one content-identical version, an under-trigger silently withholds a real
  release. `check:release-trigger` self-tests the list against real merges.
  Dispatch exists to re-run a release at the same commit.
- **`gate`** runs the contributor gate on every platform CI covers, as CI does.
- **`release`** needs both. It preflights the publish environment (see
  [Trusted publishing](#trusted-publishing)), rebuilds the commit and runs
  `node scripts/release.mts next`. The guarantee is that the commit passed, not
  that these exact files did; both builds come from the same commit and
  lockfile.

The gate lives here rather than in CI because both workflows fire on the same
`push: main` with no dependency either way, so a red CI run cannot stop a
publish. CI asserts the arrangement instead: it fails unless `release.yml`'s
gate runs CI's command on CI's `os:` list and the publishing job needs the gate
job.

The install-shape smokes in
[Testing](testing.md#install-shape-smokes-on-demand) are not part of the
release gate; run them before merging a package or export change.

## Trusted publishing

Publishing authenticates over OIDC, and `release.yml` deliberately sets no
`NODE_AUTH_TOKEN`: npm reaches for OIDC only when it finds no usable token, so
a token in the environment silently takes precedence and the trusted-publisher
path is never exercised. Two configuration details cause most failures, and
both are silent:

- **`actions/setup-node` must not be given `registry-url`.** Given one, it
  writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into an `.npmrc`
  and points `NPM_CONFIG_USERCONFIG` at it. With no token that expands to an
  *empty* token, which npm treats as a credential, so it never attempts the
  exchange and the publish fails with `ENEEDAUTH`, or with a 404 that is really
  a 403 ([actions/setup-node#1551][1551]).
- **The workflow filename in the publisher configuration is a filename, not a
  path**, and it is case-sensitive. Renaming `release.yml` breaks every
  configuration at once, and npm does not validate a configuration when it is
  saved: the first signal is a failed publish.

`release.yml` sets no `NPM_CONFIG_PROVENANCE`, because OIDC attaches provenance
by itself and the variable would make a run that quietly fell back to another
credential look provenanced in the log while attaching nothing. Confirm
provenance on the registry page.

[1551]: https://github.com/actions/setup-node/issues/1551

## Adding a package to the published set

Trusted publishing is configured **per package**, and only for a package that
already exists, so a new package's first publish cannot use OIDC. Until it is
configured, it fails the next release for the whole lockstep set.

1. Publish the package once **locally**, under `npm login`. `release.yml`
   cannot: its preflight fails on any `_authToken`, because a token would take
   precedence over OIDC. That version carries no provenance; the first OIDC
   publish attaches it.
2. Configure the publisher:

   ```bash
   npm trust github --repo eclipse-emfcloud/hydranium \
     --file release.yml --allow-publish --yes
   ```

   `--allow-publish` is not optional: without it a new configuration allows
   only `npm stage publish`, turning every release into a staged submission
   awaiting 2FA approval. Account-level 2FA is required, and granular tokens
   with the bypass option are rejected.
3. `npm logout`, so no credential can take precedence over OIDC on a later
   local run.

Publishing a scoped package over OIDC has an open failure report
([npm/cli#8976][8976]), so confirm the next automated release carries the new
package.

[8976]: https://github.com/npm/cli/issues/8976

## Cutting the stable release

Three things in one commit, and the second is the one that bites:

1. Set the base to the stable version (the `-next` base without its suffix)
   and publish with `node scripts/release.mts latest`.
2. **Move the base on to the next minor's `-next`.** After the cut,
   `git describe` finds the stable tag and the counter resets, so a base left
   at the old `-next` computes `<old base>.1`, which sorts *below* the release
   just cut and is probably already published.
3. Tag `v<stable version>`.

`scripts/release.mts` guards both halves: `next` refuses a base that is not a
`-next` version, and `latest` refuses one that is.

Right after the cut, `next` still points at the last prerelease and so is
*behind* `latest`, until the first prerelease of the new line.

## Re-deriving the scaffold provenance targets

`examples/bookstore/server` is generated from the `init` templates and recorded
as `identical`, so any change to what `init` emits leaves those targets stale.
Re-derive them; never hand-edit the derived copy:

```bash
npm run build                                  # see the warning below
node scripts/check-init-provenance.mts --write
```

**Build first, or this silently does the wrong thing.** The script imports
`packages/cli/lib/commands/init.js`, so against a stale or absent build it
reports a FALSE CLEAN and `--write` re-derives from the *previous* template,
baking a stale README into the published example and certifying it as
matching.

## Changesets

Changesets feed only the CHANGELOG for the stable cut, never the version; when
to write one is in [Commits & PRs](../CONTRIBUTING.md#commits--prs).
