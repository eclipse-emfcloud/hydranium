# Working on Hydranium

The commands a session changing the framework runs, and which page to read
before which change. The pages hold the rules; this file repeats only the
commands. Building a language on the framework is the other direction:
[Adopting Hydranium](docs/ADOPTING.md).

## Read before a change

- [Contributing](docs/CONTRIBUTING.md): setup, the gate, commits and pull
  requests, and under "How the framework is built" the design pages, each
  stating one area's contracts. Read the page of the area a change touches.
- [Conventions](docs/contributing/conventions.md): the rules code, comments,
  messages and docs follow, and which of them a gate enforces. Read "Comments
  and documentation" before writing a comment, a page or a README.
- [Testing](docs/contributing/testing.md): the layers, which one a change
  needs, and the traps that make a test pass without proving anything. Read
  "A control that refuses to redden" before trusting a new test.
- Use the Node version `.nvmrc` names and the npm version the root
  `packageManager` field names; nothing selects that npm for you
  ([Development setup](docs/CONTRIBUTING.md#development-setup)).

## Which package a change belongs in

- A change to how one protocol serves its clients goes in that head: the
  LSP head is the `lsp` subpath of `@hydranium/core`, the data head is
  `@hydranium/data-server`, the GLSP head is `@hydranium/glsp-server`.
- A head's client-side packages carry its name with `client` and, where
  there is one, the host, as `data-client-theia` does.
- Behaviour every head's server shares goes in `@hydranium/core`.
- Anything a client also needs, a wire type, a contract, the client tier or a
  utility both ends use, goes in `@hydranium/protocol`, the one package a
  pure client depends on, since `core` carries Langium.
- A host concern every head shares goes in that host's cross-head client
  package, `@hydranium/client-theia` or `@hydranium/client-browser`.
- A Langium re-export or augmentation goes in `@hydranium/langium`, the
  chokepoint. The CLI and the conformance kit are tooling packages of their
  own.

Within a package,
[The `./node` boundary](docs/contributing/conventions.md#the-node-boundary)
says which tier a module belongs on.
[How it works](docs/concepts/how-it-works.md) describes the heads, and
[Package naming](docs/contributing/conventions.md#package-naming) the rule
behind the layout.

## The gate

```bash
npm run check
```

Read the verdict from the last line: `✓ GATE PASSED`, or `✗ GATE FAILED` with
the clause that decided it. Turbo's `Tasks: N successful` is not the verdict,
and a capture without the line did not finish.

CI classifies the changed paths, builds, and runs only the gate's tail on a
docs-only change. Mirror it before a pull request:

```bash
npm run build:all
git diff --name-only --no-renames origin/main...HEAD | node scripts/ci-changed.mts
node scripts/run-gate.mts check:rest   # when that printed full=false
npm run check                          # otherwise
```

## Tests

```bash
npm exec -w @hydranium/core -- vitest run test/<file>.test.ts              # one file
npm exec -w @hydranium/core -- vitest run test/<file>.test.ts -t '<name>'  # one test
```

A `-t` that matches nothing still exits 0. A test normally imports its own
package's `src`, but reaches every `@hydranium/*` package it names, an
example's server and its own published subpaths included, through built
`lib`; every e2e tier runs built code. After editing anything a test reaches
by package name, run `npm run build`; before an example's tests or an e2e
tier, `npm run build:all`. Otherwise the run tests stale code.

## New files

```bash
node scripts/header.mts <file>
```

applies the license header `check:headers` requires on every source file,
uncommitted ones included.
