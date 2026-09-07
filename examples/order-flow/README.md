# order-flow — the example the framework gates on

Order fulfillment, modelled in **three grammars** and served to **four hosts**
off one language server: a Theia app, a VS Code extension, a plain browser page,
and the bare server on stdio. All three heads — LSP, the typed data server, and
GLSP — run over one shared Langium workspace.

**This is where a framework claim gets proved, and the grammar count is the
reason.** A single-grammar head cannot tell "reflects the head" apart from
"reflects the only language it has", and a cross-grammar reference chain exists
in no one language — so the assertions that matter can be made here and nowhere
else in this repository.

[`examples/bookstore`](../bookstore/README.md) is the deliberate opposite: a
single-grammar on-ramp that gates nothing and stays comparable, file by file,
with what `hydranium-cli init` scaffolds. Coverage belongs here. Nothing belongs
there that `init` does not already emit.

## The packages

One directory, one package per host. The npm names are flat
(`@hydranium/example-order-flow-*`), so a package name is not a path — and
`workspace/` is a fixture tree, **not** an npm workspace.

| Directory                                     | What it is                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`server/`](server/README.md)                 | the three grammars, the adopter services and all three heads. **Start here.**                          |
| [`client/`](client/README.md)                 | the host-agnostic web client: one diagram definition and one properties model, mounted by every shell  |
| [`theia/`](theia/README.md)                   | the Theia extension — diagram, properties view, diagnostics commands                                   |
| [`theia-app/`](theia-app/README.md)           | the Theia browser application, and the host of the Playwright e2e suite                                |
| [`vscode/`](vscode/README.md)                 | the VS Code extension — two webviews and the extension-host wiring behind them                         |
| [`vscode-servers/`](vscode-servers/README.md) | server hosting with no UI, shared by the VS Code shell and sideloaded by the Theia app                 |
| [`browser/`](browser/README.md)               | all three heads in one web worker: no Node, no backend process, no socket                              |
| [`workspace/`](workspace/README.md)           | the sample models every host opens                                                                     |

## Which one do I read first

- **Building a language** — `server/`. It is the only package that touches
  grammars, scoping, validation and serialization, and its README also records
  which files came from `hydranium-cli init` and which are hand-written.
- **Building a host** — `client/` first (what is host-neutral), then whichever
  shell is closest to yours. `theia/` is the short one, because the framework
  ships Theia client packages; `vscode/` is the long one, because it does not.
- **Wondering what a head can do with no shell at all** — `browser/`.

## The three grammars

| Extension  | Language id          | What it holds                                                                                       |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `.domain`  | `order-flow-domain`  | entities, value types, enumerations, typed fields — structural, so text is the better editor         |
| `.process` | `order-flow-process` | tasks, gateways, transitions over a domain entity — behavioural, so a graph is the better editor     |
| `.layout`  | `order-flow-layout`  | node bounds for one process, in its own file — purely additive, a `.process` with no `.layout` works |

References point one way down the chain: `.layout` depends on `.process`
depends on `.domain`, never the reverse.

**There is no `.diagram` grammar.** A diagram here is a `.process` document
rendered by the GLSP head, with its positions in the sibling `.layout` file.

The single line the whole example exists for lives in `.process`:

```text
task Pay writes Order.status = PAID
```

Three cross-references, each scoped by the previous one — an entity, then a
field of _that_ entity, then a literal of the enumeration _that field_ is typed
with. `server/README.md` carries the rest.

## The fixture workspace is edited in place

`workspace/` is a checked-in test fixture, and two of the ways to run this
example open it **directly**: the Theia app's `npm start` passes `../workspace`
to `theia start`, and the VS Code F5 launch opens the same folder. Anything you
type — or write from a properties panel, which reserializes the whole document —
changes the seed other suites copy.

Nothing warns you, because the suites still pass: they copy the file you
changed. So run `git status examples/order-flow/workspace` after any manual
session, and `git checkout --` what you did not mean to keep. The Playwright
suites are exempt (they copy the tree into a temp directory first), and so is
the browser page (it seeds an in-memory filesystem and persists to `IndexedDB`).

## Running it

```bash
npm run build:all                                  # every package, in dependency order

npm run start:order-flow                           # build + Theia app on http://localhost:3001
npm run dev:order-flow                             # watch: framework + server/client/theia/app

npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser start     # http://localhost:3002

npm --prefix examples/order-flow/vscode run build:all   # then F5 in VS Code

npm --prefix examples/order-flow/server run build
npm --prefix examples/order-flow/server start      # the LSP head alone, on stdio
```

Each package's own README has the detail, including the e2e commands and the
launch-configuration names.

## What `npm run check` covers here, and what it does not

- The `server`, `client` and `theia` suites run under `turbo run test`, so they
  are in `check`.
- **Neither Playwright tier is.** `theia-app` and `browser` have no `test`
  script, deliberately, so a full `check` needs no browser binary. `theia-app`
  still typechecks its specs through `typecheck:test`, which turbo does run.
- `check:host-load` requires the VS Code extension's built `main` in bare Node
  with `vscode` stubbed; `check:webview-csp` scans its two webview bundles;
  `check:init-provenance` re-derives `server/` from the `init` invocation its
  README documents.

The framework-level maps this example is an instance of are
[`docs/concepts/architecture.md`](../../docs/concepts/architecture.md),
[`docs/concepts/head-module-maps.md`](../../docs/concepts/head-module-maps.md)
and [`docs/contributing/testing.md`](../../docs/contributing/testing.md).
