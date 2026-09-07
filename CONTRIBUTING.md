# Contributing to Hydranium

Thanks for your interest. The project is in **alpha** and the API is not yet
stable — expect breaking changes between releases. The version number does not
say so: the release line starts at 1.0.0, because a 0.x line cannot take a
minor bump under this repository's peer topology, and the alpha signal is
carried by an npm dist-tag instead. [`docs/contributing/releasing.md`](docs/contributing/releasing.md)
has the measurement and the consequences.

## Reporting issues

Open a GitHub issue. Two templates are offered — a bug report and a question —
and each asks for what we need to act on it: steps to reproduce, expected vs.
actual behaviour, and your Node, npm, `@hydranium/*` and Langium versions.

Because the API surface is still moving, a question describing what you were
trying to build is often more useful than a patch against a seam that is about
to change.

**Security vulnerabilities do not go here.** They follow the Eclipse Foundation
coordinated-disclosure process — see [`SECURITY.md`](SECURITY.md).

## Code of conduct

This project follows the
[Eclipse Community Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

```bash
git clone https://github.com/eclipse-emfcloud/hydranium.git
cd hydranium
npm install
npm run build
npm install          # see the note below — required once, after the first build
npm test
```

Node 22.13 or newer is required, and npm 11.15.0 — the version the root
`packageManager` field names. **Nothing selects that version for you.** npm
does not act on `packageManager` on its own; Corepack would, but only once it
has been switched on explicitly (`corepack enable`), and `actions/setup-node`
reads the field as a caching hint rather than as a version to install. Install
it yourself:

```bash
npm install -g npm@11.15.0
```

CI does the same, in a `Pin the toolchain` step that reads the version out of
`package.json` and then asserts that `npm --version` reports it — so the
workflow cannot fall behind a bump to the pin, and a global install that lands
off the front of `PATH` reddens instead of passing quietly. The same step
checks the running Node against `engines.node` rather than trusting the
version the runner resolved: both workflows ask `actions/setup-node` for
`node-version-file: .nvmrc`, so one edit moves CI and a local `nvm use`
together, but a version file is a *spec* and not a guarantee — whoever edits
it is free to widen it back below the `22.13` floor. `.nvmrc` currently reads
`22.13.0`, and a CI step compares the two workflows' `node-version-file`
values so they cannot drift apart.

**Why `npm install` twice on a fresh clone.** `lib/` is build output and is not
committed, so `packages/cli/lib/cli.js` does not exist when the first install
runs — and npm silently skips a workspace `bin` symlink whose target is missing.
The `hydranium-cli` binary is therefore absent until an install runs *after* a
build, and until then `examples/bookstore/server`'s `generate` step fails with
`hydranium-cli: not found`. The second install creates the link; after that the
full gate passes. This bites only on a cold clone: once the link exists it
survives.

**Install with dev dependencies, always.** The root `postinstall` runs
`patch-package`, which re-adds the `main` and `typings` fields that
`vscode-jsonrpc@9.0.1` ships without; every `moduleResolution: "Node"` project
in the graph fails with `TS2307` on `vscode-jsonrpc` if the patch is missing.
`patch-package` is itself a devDependency, so an install that omits dev
dependencies — `npm ci --omit=dev`, or `NODE_ENV=production` — cannot find the
binary and the patch is not applied. Both workflows run a plain `npm ci`;
keep them that way, or move `patch-package` to `dependencies` first, which
changes what a consumer of this repository installs and so is not obviously
the cheaper option. The patch repairs *this* tree only and is not
redistributable; what a project consuming the published packages has to do
instead is
[`docs/adopting/requirements.md`](docs/adopting/requirements.md).

The consumer-side half of the same packaging defect — what a project
compiling against the *published* packages has to do, given that the patch
reaches no published tarball — is stated in
[`README.md`](README.md#requirement-your-project-must-resolve-vscode-jsonrpc9).

### Two standing constraints on npm lifecycle scripts

Both were measured on a cold clone, and together they are why no workspace in
this repository defines a `prepare` script.

- **npm runs a workspace's `prepare` before the root `postinstall`.** So no
  workspace lifecycle script can compile against the patched
  `vscode-jsonrpc`: while `prepare` runs, the dependency is still exports-only
  and every `moduleResolution: "Node"` project in the graph fails with
  `TS2307`. The order is not negotiable from inside a workspace manifest.
- **A failing workspace `prepare` rolls back the *entire* install.** `npm ci`
  exits non-zero and leaves no `node_modules` directory at all — so the next
  command dies with `turbo: not found`, and the only error the contributor is
  shown is a TypeScript error in some package they never asked to build. The
  real cause and the visible symptom are two packages apart.

That pair is why the publish guards are `prepack` and not `prepare` (see the
`//prepack` note in any package manifest): `prepack` runs when a tarball is
made and never on install, so it cannot break an install it has no business
touching. Before proposing any new install-time lifecycle script, check it
against both constraints — they have invalidated three otherwise reasonable
fixes.

## The gate

`npm run check` is an `&&` chain, not a single command: `turbo run build lint
typecheck:test test`, then `check:neutral`, `check:host-load`,
`check:webview-csp`, `check:exports`, `check:glob-coverage`, `check:readme`,
`check:readmes`, `check:init-provenance`, `check:deps`, `check:link-tags`,
`check:headers`, `check:licenses` and `format:check`. The
list here is a map, not the contract — read the chain out of `package.json`
before relying on its extent. Turbo is only the first element, so read
the END of the run rather than turbo's task count — `Tasks: N successful` can
print while a later clause reddens.

## Testing

`npm run check` runs the full gate (above) across every package — run it before
opening a PR. For the layered test strategy, the
per-package / single-file commands, the Playwright UI e2e, and the on-demand
mutation and perf audits, see [`docs/contributing/testing.md`](docs/contributing/testing.md).

## Code style

- TypeScript strict mode.
- ESLint + Prettier — run `npm run lint` and `npm run format` before committing.
- Headers — every source file carries the standardised license header (see any
  existing file for the pattern). Run `node scripts/header.mjs <file>` to
  apply it to a new file. `npm run check:headers` (part of `npm run check`)
  fails if any source file is missing it, new and uncommitted files included.

## Commits & PRs

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, etc.).
- One concern per PR. Smaller is better.
- Add a changeset, or the explicit empty marker if the change needs no
  release. Nothing in CI enforces this, so a PR without either ships
  unversioned and absent from every CHANGELOG — see
  [`docs/contributing/releasing.md`](docs/contributing/releasing.md), which is also the runbook for
  versioning policy, dist-tags and provenance.
- Reference the concept doc under `docs/concepts/` your change follows, if there is one.
- A test must justify its existence: it should catch a real class of bug.

## Licensing and the Eclipse Contributor Agreement

By contributing, you agree that your contributions are licensed under the
project's license: `MIT`.

This project is hosted by the Eclipse Foundation, so contributing to it carries
two requirements beyond that.

- **Sign the [Eclipse Contributor Agreement](https://www.eclipse.org/legal/eca/).**
  It is signed once, against an Eclipse Foundation account, and it covers every
  Eclipse project. Use the same email address on the account as on your commits
  — the check matches them, and a mismatch is the usual reason a pull request
  from a signatory is still blocked.
- **Sign off every commit** with `git commit -s`, which appends the
  `Signed-off-by` line the agreement requires. It is per commit, not per pull
  request, so a branch with one unsigned commit does not pass.
