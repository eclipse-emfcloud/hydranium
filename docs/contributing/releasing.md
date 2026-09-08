# Releasing Hydranium

Every merge to `main` publishes. There is no release ceremony, no version
commit and no approval step between a merged PR and a version on npm —
so the thing to understand before reading further is that the version
number is **derived**, never written down.

## The version

Each release is `1.0.0-next.<n>`, where `n` counts the commits since the
last release tag. `1.0.0-next` is the **base**, committed in the root
manifest and in all ten package manifests; `.<n>` is appended by
`scripts/release.mjs` in the runner's tree and is never committed.

Three properties follow, and each is load-bearing:

- **It is monotonic.** A commit hash is not: a seven-character short SHA
  is all digits about 4% of the time, and semver compares an all-numeric
  prerelease identifier *below* every alphanumeric one — so roughly one
  release in twenty-five would sort behind its predecessor. Worse, a
  numeric identifier with a leading zero is not valid semver at all, so
  about one in 270 would fail to publish.
- **No range matches it.** `^1.0.0` resolves no prerelease, so a
  dependency range can never pick up a nightly by accident. A consumer
  has to ask for the version, or for a dist-tag.
- **The stable release sorts above all of it.** `1.0.0-next.999 <
  1.0.0`, so cutting `1.0.0` is a clean upgrade from every nightly that
  preceded it.

All ten packages publish **in lockstep** at the same version, and the
intra-framework ranges are rewritten to that version **exactly** — not
with a caret. `^1.0.0-next.7` also matches `1.0.0` and `1.1.0`, so a
caret minted on a nightly would let a consumer of one package resolve a
sibling from a future stable line. The set that publishes is the set
that was built together.

## Dist-tags

**Until the first stable release, every nightly publishes to `latest`.**
That looks wrong and is not. npm assigns `latest` to the first version
of a new package whatever `--tag` asks for, so publishing only to `next`
would strand `latest` on the very first nightly, permanently — a bare
`npm install @hydranium/core` would resolve a version from months ago.
Moving it afterwards is not an option either: `npm dist-tag add` cannot
authenticate over OIDC ([npm/cli#8547][8547]), so it would mean keeping
a long-lived token for that one call.

After the first stable release, `latest` belongs to the stable line and
the rolling line moves to `next`.

`scripts/release.mjs` **derives** which of the two applies by asking the
registry whether any non-prerelease version exists, rather than reading
a flag someone has to remember to flip on the day it stops being true.

[8547]: https://github.com/npm/cli/issues/8547

## How a release runs

`.github/workflows/release.yml`, on every push to `main` and on
`workflow_dispatch`:

1. Checks out with `fetch-depth: 0` — the counter needs the tags.
2. Pins the toolchain to the `packageManager` version.
3. Preflights the publish environment (see below).
4. Installs, builds, and runs the **whole contributor gate**
   (`npm run check`) in this workflow, before the publish.
5. Runs `node scripts/release.mjs next`.

The gate lives here rather than in CI deliberately: both workflows fire
on the same `push: main` with no dependency either way, so they race and
a red CI run cannot stop a publish. CI asserts the arrangement instead —
a step reads `release.yml` and fails unless `npm run check` appears at a
lower line number than the publish, because a gate after the publish is
not a gate.

## Trusted publishing

Publishing authenticates over OIDC. There is no npm token, and
`release.yml` deliberately sets no `NODE_AUTH_TOKEN`: npm only reaches
for OIDC when it finds no usable token first, so a token in the
environment does not add a fallback — it silently takes precedence, and
the trusted-publisher path is never exercised.

Two configuration details cause most of the failures, and both are
silent:

- **`actions/setup-node` must not be given `registry-url`.** Given one,
  it writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into
  an `.npmrc` and points `NPM_CONFIG_USERCONFIG` at it. With no token
  that expands to an *empty* token, which npm treats as a credential to
  use — so it never attempts the exchange, and the publish fails with
  `ENEEDAUTH`, or with a 404 that is really a 403.
  ([actions/setup-node#1551][1551])
- **The workflow filename in the publisher configuration is a filename,
  not a path**, and it is case-sensitive. Renaming `release.yml` breaks
  every configuration at once, and npm does not validate a
  configuration when it is saved — the first signal is a failed publish.

Provenance is attached automatically under OIDC, so `release.yml` sets
no `NPM_CONFIG_PROVENANCE`: setting it would make a run that had quietly
fallen back to another credential still look provenanced in the log
while attaching nothing. Confirm it on the registry page.

[1551]: https://github.com/actions/setup-node/issues/1551

## Bootstrapping (one time)

Trusted publishing is configured **per package**, and a package must
already exist before it can be configured — so the first publish cannot
itself use OIDC. In order:

1. Cut a release tag so the counter has a floor. The match pattern is
   deliberately narrow (`v[0-9]*.[0-9]*.[0-9]*`): this repository
   carries marker tags such as `v0-api-freeze`, which a naive `v[0-9]*`
   matches — `v` followed by `0-api-freeze` — and would silently anchor
   every version number to a tag that is not a release.
2. Publish once with a token, **from CI rather than a laptop**. A local
   `npm publish` has neither `id-token: write` nor provenance and looks
   entirely successful.
3. Configure the publisher for each package:

   ```bash
   npm trust github --repo eclipse-emfcloud/hydranium \
     --file release.yml --allow-publish --yes
   ```

   `--allow-publish` is not optional. Configurations created from
   2026-09-03 allow only `npm stage publish` by default, which would
   turn every release into a staged submission awaiting 2FA approval.
   Account-level 2FA is required, and granular tokens with the bypass
   option are rejected.
4. Verify on **one** package before trusting all ten — publishing scoped
   packages over OIDC has an open failure report ([npm/cli#8976][8976]).
5. Delete the `NPM_TOKEN` secret and revoke the token.

[8976]: https://github.com/npm/cli/issues/8976

## Cutting the stable release

Three things in one commit, and the second is the one that bites:

1. Set the base to `1.0.0` and publish with
   `node scripts/release.mjs latest`.
2. **Move the base on to `1.1.0-next`.** `git describe` now finds
   `v1.0.0`, so the counter resets — with the base still at
   `1.0.0-next`, the next nightly computes `1.0.0-next.1`, which sorts
   *below* the release just cut and is probably already published.
3. Tag `v1.0.0`.

`scripts/release.mjs` guards this from both sides: `next` refuses a base
that is not a `-next` version, and `latest` refuses one that is. Each
catches the other's forgotten half.

Expect one transient: immediately after the cut, `next` still points at
the last nightly and is therefore *behind* `latest`. It corrects itself
on the first nightly of the new line.

## Two edits that must ride the first publish

Neither is automated and neither reddens a gate, so both are silent when
skipped and visible only on the published artefact.

**1. Rewrite the README's prerelease blockquote.** `README.md` opens its
getting-started section with a note describing the rolling line. Until
the first version reaches the registry that note is *ahead* of reality —
the `npx` lines it governs still answer 404. It is accurate from the
first publish onward, and wrong before it, so the window is closed by
publishing rather than by editing.

**2. The scaffold's own note needs no edit at all.** `init-templates.ts`
emits its pre-publish note only while the CLI package's own version
equals the `UNPUBLISHED_FRAMEWORK_VERSION` sentinel `'0.0.0'`, and pins
a scaffolded project at `^<that version>`. The sentinel stays `'0.0.0'`
permanently — it is a comparison operand, not a value to update.

What *does* need doing, and at the **version bump** rather than the
publish: setting the base flips that comparison, so the scaffold stops
emitting the note and `examples/bookstore/server/README.md` — a derived
target recorded `identical` — no longer matches. Re-derive it:

```bash
npm run build                                  # see the warning below
node scripts/check-init-provenance.mjs --write
```

**Build first, or this silently does the wrong thing.** The script
imports `packages/cli/lib/commands/init.js`, so against a stale or
absent build it reports a FALSE CLEAN and `--write` re-derives from the
*previous* template — baking a stale README into the published example
and certifying it as matching. Never hand-edit the derived copy.

## What changesets is still for

`@changesets/cli` remains installed, and `npx changeset` still records
release notes. It does **not** drive versioning or publishing on the
rolling line — the version is derived, so there is nothing for
`changeset version` to compute — and the repository is deliberately not
in pre-release mode. Its role is the CHANGELOG for the stable cut.

Two consequences worth knowing before reaching for it: pre-release mode
forbids snapshot releases outright, and `changeset version` exits early
when no changesets are pending, so neither offers a rolling mechanism
this could have used instead.
