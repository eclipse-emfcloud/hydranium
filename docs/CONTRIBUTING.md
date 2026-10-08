# Contributing to Hydranium

Thanks for your interest. The project is in **alpha**: the API is not yet
stable, so expect breaking changes between releases.
[Stability and versioning](adopting/status.md#stability-and-versioning) says
what the version number does and does not promise.

## How the framework is built

The design behind what the adopter pages under
[How it works](ADOPTING.md#how-it-works) describe; read those first.

- [**Model coordination**](contributing/design/model-coordination.md) — how
  the heads share one document through one text store and one manager.
- [**Client sessions**](contributing/design/client-sessions.md) — the full
  contract of a session on each head: when a write answers, how a reconnect
  restores, how editor saves and the release grace work.
- [**The four document layers**](contributing/design/document-layers.md) — what the user
  typed, what Langium built from it, what in-process consumers get, what
  crosses the wire, and why the last two are different types.
- [**Service placement and composition**](contributing/design/service-placement.md)
  — why each service sits on the shared or the per-language tier, and why
  composition has no framework layer over Langium's.
- [**Build pipeline**](contributing/design/build-pipeline.md) — how build-time
  work is wired into Langium's document build, and why integrity and adopter
  passes share one priority space.
- [**GLSP operations**](contributing/design/glsp-operations.md) — how a
  diagram operation edits a working copy and writes it once, and what runs
  again on undo and redo.
- [**Browser hosting**](contributing/design/browser-hosting.md) — why the
  packages split into portable and Node-only entries, and what the neutrality
  gate does and does not promise.
- [**Scope and candidate services**](contributing/design/scope-services.md) —
  how reference handling is split between scope resolution and the candidate
  pipeline, and why.

## Developer documentation

- [**Conventions**](contributing/conventions.md) — the rules code, comments,
  messages and docs follow, and which of them a gate enforces.
- [**Testing**](contributing/testing.md) — the test layers, which one a change
  needs, and the commands.
- [**Releasing**](contributing/releasing.md) — how a push to `main` that can
  change a published package becomes a prerelease (the `changes` job in
  `release.yml` skips the others), and how the first stable release is cut.
- [**Troubleshooting the repository**](contributing/troubleshooting.md) —
  failures that only happen while building or testing this repo.
- [**Performance baseline**](contributing/perf-baseline.md) — how to take a
  measurement that is comparable with an earlier one.

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

Use the Node version `.nvmrc` names (it must satisfy the root `engines.node`)
and the npm version the root `packageManager` field names. **Nothing selects
that npm for you**: npm ignores `packageManager`, and Corepack acts on it only
once switched on. Install it with `npm install -g npm@<that version>`. CI
installs and asserts the same versions.

### A standing constraint on npm lifecycle scripts

Install-time lifecycle scripts must not fail: a failing workspace `prepare`
rolls back the whole install, so the error a contributor sees is packages away
from its cause. The publish guards are therefore `prepack`, which runs only
when a tarball is made, not `prepare`.

## Repository layout

```
hydranium/
├── packages/                   # @hydranium/* packages
├── examples/                   # bookstore and order-flow
├── docs/                       # adopter and developer documentation
├── scripts/                    # repository gates and the license-header tool
├── ast-grep/                   # ast-grep rules and their tests
└── .github/workflows/          # CI
```

## Development loop

```bash
npm run build:all      # framework and every example app via turbo
npm run watch:all      # one tsc -b -w daemon for the framework graph
npm run dev:order-flow # framework watch plus the order-flow example's watches
# then, in a second terminal, the order-flow Theia application:
npm --prefix examples/order-flow/theia-app run start
```

## Linting and formatting

TypeScript runs in strict mode (`tsconfig.base.json`). `npm run lint` runs
Oxlint, native rules only; `oxlint.config.cjs` scopes the architecture rules
to their packages. Two checks cover what Oxlint has no native rule for:
`npm run check:phantom-deps` requires every import to be declared in its
workspace's manifest, and `npm run check:ast-grep` runs the localization and
test-fixture bans in `ast-grep/rules`, after their tests in `ast-grep/tests`.
`npm run check:lint-policy` plants violations and permitted exceptions at real
paths and runs the enforcing tool on each.

`npm run format` formats source and configuration files with Oxfmt and
`npm run format:check` checks them; `.oxfmtignore` excludes generated files,
build output, lockfiles and Markdown. In VS Code, the Oxc and ast-grep
extensions from `.vscode/extensions.json` show both tools' findings, and Oxc
formats with this configuration.

Every source file carries the standard license header: `node scripts/header.mts
<file>` applies it, and `npm run check:headers` fails on any file without it,
uncommitted ones included.

## The gate

`npm run check` is a chain of clauses: turbo's build, lint, typecheck and test
first, then the repository's `check:*` gates and `format:check`;
`scripts.check` and the `check:rest*` scripts it calls are the list. Turbo's
`Tasks: N successful` is therefore not the verdict. The run ends in one line
that is, `✓ GATE PASSED` or `✗ GATE FAILED` with the clause that decided it; a
capture without that line did not finish, and only its exit code knows.

On a pull request, CI first classifies the changed paths with
`scripts/ci-changed.mts`. A change that is only prose runs `check:rest` on one
platform and skips the build, the tests and e2e; anything else runs the full
gate. To mirror it locally, run

```bash
git diff --name-only --no-renames origin/main...HEAD | node scripts/ci-changed.mts
```

then `node scripts/run-gate.mts check:rest` on `full=false`, and
`npm run check` otherwise.

## Testing

Run the gate before opening a PR; [Testing](contributing/testing.md) covers
the test layers, the narrower commands, e2e and the on-demand audits.

## Commits & PRs

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, etc.).
- One concern per PR. Smaller is better.
- **No changeset until the first stable release**, because until then no
  adopter has a version to upgrade from and nothing reads one.
- **From the first stable release on, one changeset per user-visible change**
  (`npx changeset add`), named for the change rather than the generated name,
  and never empty. [Releasing](contributing/releasing.md) covers versioning,
  dist-tags and provenance.
- Reference the design page under `docs/contributing/design/` your change
  follows, if there is one.
- A test must justify its existence: it should catch a real class of bug.

## Licensing and the Eclipse Contributor Agreement

By contributing, you agree that your contributions are licensed under the
project's license: `MIT`.

This project is hosted by the Eclipse Foundation, so contributing to it carries
one requirement beyond that.

- **Sign the [Eclipse Contributor Agreement](https://www.eclipse.org/legal/eca/).**
  It is signed once, against an Eclipse Foundation account, and covers every
  Eclipse project. The `eclipsefdn/eca` check resolves the author address of
  each commit in a pull request to an Eclipse account and reports whether that
  account has signed, so use the same address on the account as on your
  commits — a mismatch is the usual reason a signatory's pull request is still
  blocked. The check's status page lists the addresses it resolved.
