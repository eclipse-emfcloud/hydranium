# Contributing to Hydranium

Thanks for your interest. The project is in **alpha**: the API is not yet
stable, so expect breaking changes between releases.
[Stability and versioning](adopting/status.md#stability-and-versioning) says
what the version number does and does not promise.

## Developer documentation

- [**Conventions**](contributing/conventions.md) — the rules code, comments,
  messages and docs follow, and which of them a gate enforces.
- [**Testing**](contributing/testing.md) — the test layers, which one a change
  needs, and the commands.
- [**Releasing**](contributing/releasing.md) — how every merge to `main`
  becomes a prerelease, and how the first stable release is cut.
- [**Troubleshooting the repository**](contributing/troubleshooting.md) —
  failures that only happen while building or testing this repo.
- [**Performance baseline**](contributing/perf-baseline.md) — how to take a
  measurement that is comparable with an earlier one.
- How the framework is built:
  [document layers](concepts/document-layers.md),
  [model coordination](contributing/design/model-coordination.md),
  [service placement](contributing/design/service-placement.md),
  [scope services](contributing/design/scope-services.md) and
  [build-pipeline registries](concepts/build-pipeline-registries.md).

## Reporting issues

Open a GitHub issue. Two templates are offered — a bug report and a question —
and each asks for what we need to act on it: steps to reproduce, expected vs.
actual behaviour, and your Node, npm, `@hydranium/*` and Langium versions.

Because the API surface is still moving, a question describing what you were
trying to build is often more useful than a patch against a seam that is about
to change.

**Security vulnerabilities do not go here.** They follow the Eclipse Foundation
coordinated-disclosure process — see [`SECURITY.md`](../SECURITY.md).

## Code of conduct

This project follows the
[Eclipse Community Code of Conduct](../CODE_OF_CONDUCT.md).

## Development setup

```bash
git clone https://github.com/eclipse-emfcloud/hydranium.git
cd hydranium
npm install
npm run build
npm test
```

Node 22.18 or newer is required, and npm 11.15.0 — the version the root
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
it is free to widen it back below the `22.18` floor. `.nvmrc` currently reads
`22.18.0`, and a CI step compares the two workflows' `node-version-file`
values so they cannot drift apart.

### A standing constraint on npm lifecycle scripts

**A failing workspace `prepare` rolls back the *entire* install.** `npm ci`
exits non-zero and leaves no `node_modules` directory at all — so the next
command dies with `turbo: not found`, and the only error the contributor is
shown is a TypeScript error in some package they never asked to build. The real
cause and the visible symptom are two packages apart.

That is why the publish guards are `prepack` and not `prepare` (see the
`//prepack` note in any package manifest): `prepack` runs when a tarball is
made and never on install, so it cannot break an install it has no business
touching. Check any new install-time lifecycle script against it.

## Repository layout

```
hydranium/
├── packages/                   # @hydranium/* packages
├── examples/                   # bookstore and order-flow
├── docs/                       # adopter and developer documentation
├── scripts/                    # repository gates and the license-header tool
├── internal/                   # tracked, and excluded from the published tree
└── .github/workflows/          # CI
```

`internal/` holds the work log, the design plans and the maintainer-only
tooling. It is in git, so a clone has it, and it is excluded by directory from
the tree a release is cut from, so nothing under it is part of the published
surface or of any package tarball.

## Development loop

```bash
npm run build:all      # framework and every example app via turbo
npm run watch:all      # one tsc -b -w daemon for the framework graph
npm run dev:order-flow # framework watch plus the order-flow example's watches
```

Then, in a second terminal, start the order-flow Theia application:

```bash
npm --prefix examples/order-flow/theia-app run start
```

## Linting

Run `npm run lint` to run Oxlint across the workspace. Oxlint runs native
rules only; `oxlint.config.cjs` scopes the architecture rules to their
packages. Two checks cover what Oxlint has no native rule for:

- `npm run check:phantom-deps` requires every import to be declared in its
  workspace's manifest (`scripts/check-phantom-dependencies.mts`).
- `npm run check:ast-grep` runs the localization and test-fixture bans in
  `ast-grep/rules`, after the rule tests in `ast-grep/tests`.

`npm run check:lint-policy` plants violations and permitted exceptions at real
paths and runs the enforcing tool on each. The Oxc and ast-grep VS Code
extensions in `.vscode/extensions.json` show both kinds of finding in the
editor.

## Formatting

Run `npm run format` to format source and configuration files with Oxfmt,
or `npm run format:check` to check them. Settings are in `.oxfmtrc.json`;
`.oxfmtignore` excludes generated files, build output, lockfiles, and Markdown.
For editor formatting, use the Oxc extension with this repository configuration.

## The gate

`npm run check` is a chain of clauses, not a single command: `turbo run build
lint typecheck:test test` first, then the repository's `check:*` gates and
`format:check`. `scripts.check` in `package.json`, with the `check:rest*`
scripts it calls, is the list. Turbo is only the first element, so turbo's task
count is not the verdict — `Tasks: N successful` can print while a later clause
reddens. The run ends in one line that is the verdict, `✓ GATE PASSED` or
`✗ GATE FAILED` with the clause that decided it; if the capture has no such
line, the run did not finish and its exit code is the only thing that knows.

## Testing

`npm run check` runs the full gate (above) across every package — run it before
opening a PR. For the layered test strategy, the
per-package / single-file commands, the Playwright UI e2e, and the on-demand
mutation and perf audits, see [Testing](contributing/testing.md).

## Code style

- TypeScript strict mode.
- Oxlint + Oxfmt — run `npm run lint` and `npm run format` before committing.
- Headers — every source file carries the standardised license header (see any
  existing file for the pattern). Run `node scripts/header.mts <file>` to
  apply it to a new file. `npm run check:headers` (part of `npm run check`)
  fails if any source file is missing it, new and uncommitted files included.

## Commits & PRs

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, etc.).
- One concern per PR. Smaller is better.
- **Write no changeset until the first stable release exists.** A changeset
  feeds one thing here, the CHANGELOG for the stable cut, and nothing yet
  reads it: the rolling version is derived from the commit count, so a change
  with no changeset still publishes. Nor would accumulating them help. A
  changelog describes what moved relative to a version somebody pinned, and
  nobody pins a prerelease of a package with no stable line — so the notes a
  1.0.0 would assemble out of them describe upgrades from versions no adopter
  had. `docs/contributing/releasing.md` is the runbook for versioning policy,
  dist-tags and provenance.
- **From the first stable release onward, every user-visible change wants
  one** (`npx changeset add`) — that is where the CHANGELOG starts being
  read, because adopters then have a baseline to upgrade from. Until then the
  directory stays empty of entries.
- **Never write an empty changeset.** It declares no package and renders no
  entry, so it records only that somebody ran the command, while sitting in a
  directory whose contents are read as pending release notes. A change that
  deserves no note gets no file.
- **Name a changeset for its change**, not with the three-word phrase the
  generator invents — `reject-non-file-writes.md` over `plain-geese-refuse.md`.
  Prefix it with the issue or PR number where one exists. The generated names
  are unique and nothing else, which is the one property a reviewer scanning
  the directory does not need.
- Reference the concept doc under `docs/concepts/` your change follows, if there is one.
- A test must justify its existence: it should catch a real class of bug.

## Licensing and the Eclipse Contributor Agreement

By contributing, you agree that your contributions are licensed under the
project's license: `MIT`.

This project is hosted by the Eclipse Foundation, so contributing to it carries
one requirement beyond that.

- **Sign the [Eclipse Contributor Agreement](https://www.eclipse.org/legal/eca/).**
  It is signed once, against an Eclipse Foundation account, and it covers every
  Eclipse project. The `eclipsefdn/eca` check resolves the author address of
  each commit in a pull request to an Eclipse account and reports whether that
  account has signed, so use the same address on the account as on your commits
  — a mismatch is the usual reason a pull request from a signatory is still
  blocked. The check's own status page lists the addresses it resolved, which
  is where to look when it is unclear which one it saw.
