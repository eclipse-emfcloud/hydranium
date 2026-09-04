# `@hydranium/cli`

The headless tool surface of the [Hydranium](https://github.com/eclipse-emfcloud/hydranium)
framework, published as the `hydranium-cli` binary.

Install it if you are building a Hydranium language. `init` scaffolds a complete project from one
invocation; the other twelve subcommands drive an already-built head from a shell or a CI step —
grammar introspection, headless validation, transfer-model codegen, memory measurement, and
operations against a spawned data-server.

## What it gives you

- **`init`** — a buildable project (starter grammar, `create<Name>Services` DI wiring, an LSP +
  data-server launch, `langium-config.json`, build scripts) from one command, or from a wizard that
  echoes the flags it composed.
- **CI gates that need no editor** — `validate` exits non-zero on a diagnostic; `lint-grammar`
  checks that every concrete cross-reference target carries a name property and that each language
  declares an entry rule.
- **Grammar introspection** — `reflect` (type hierarchy, terminals, every cross-reference target;
  Markdown or `--json`) and `model-docs` (a navigable Markdown model reference for your own docs).
- **Codegen** — `generate-transfer-model` turns a Langium-generated AST into a serializable transfer
  model, once or in `--watch`.
- **Memory and profiling** — `measure-memory`, `ast-ground-truth`, and the memlab-based
  `analyze-heap`.
- **Data-server operations** — `projects`, `query`, `save` and `watch` spawn a data-server child and
  speak its protocol, printing JSON / NDJSON a script can pipe.

## Install

> **Nothing in `@hydranium/*` is on npm yet**, so every `npx` line below
> resolves to no package and fails with `E404`. Until the first release the CLI
> is reachable only from a clone of this repository: run `npm run build`, then
> substitute `node packages/cli/lib/cli.js` for the `npx …` prefix. Subcommands,
> flags and output are the same either way.

`init` needs no install at all:

```bash
npx @hydranium/cli init ./my-lang --name MyLang
```

For the subcommands you run repeatedly, add it to the project it inspects, or install it globally:

```bash
npm install --save-dev @hydranium/cli
npm install --global @hydranium/cli
```

The framework edges are **peer dependencies** — `@hydranium/core`, `@hydranium/data-server`,
`@hydranium/langium`, `@hydranium/protocol` and `vscode-jsonrpc` — so the CLI runs the same physical
copies as the head it inspects (`init` itself needs none of them). The memlab packages
`analyze-heap` loads are **optional peer dependencies**, so installing this package pulls no browser:
run `npm install @memlab/core @memlab/heap-analysis` (heavy, ~86 MB) before the first
`analyze-heap`. Every other subcommand works without them.

## Subcommands

`hydranium-cli --help` lists them; `hydranium-cli <command> --help` prints one command's own flags.

Most subcommands take `--services <module>`: an ESM module exporting a zero-arg
`createServices(): { shared }` thunk — normally your build's `./lib/services.js`. The head wires its
own filesystem inside, so the CLI boots it with no arguments.

**Scaffolding**

- `init <target-dir>` — scaffold a new language project. See the section below.

**Grammar and workspace** (`--services <module>`)

- `reflect` — dump the grammar/AST reflection: type hierarchy, per-language terminals and entry
  rule, every cross-reference target. `--json`, `--out-file <file>`.
- `lint-grammar` — check the grammar against framework conventions; non-zero exit on a violation.
  `--name-property <p>` (repeatable), `--strict`, `--json`.
- `model-docs` — emit a navigable Markdown model reference on stdout, or into `--out-file <file>`.
- `validate <workspace>` — build a workspace headlessly and report its diagnostics; non-zero exit on
  any error. `--strict` (also fail on warnings), `--json`, `--out-file <file>`.
- `measure-memory <workspace>` — measure model-store memory in an `--expose-gc` child.
  `--edits <N>`, `--edit-docs <N>`, `--churn-suffix <ext>`, `--settle <ms>`, `--snapshot`,
  `--snapshot-path <p>`, `--profile <dims>`, `--session-out <dir>`, `--json`.
- `ast-ground-truth <workspace>` — tally the live model's AST nodes by `$type`, the ground truth
  `analyze-heap --validate` checks a snapshot against. `--out-file <file>`.

All six also take `--log-level <off|error|warn|info|debug|trace>`, which sets the threshold for the
head the subcommand boots — not for the CLI itself. It reaches the head through the child's
environment, so a head that binds a logger of its own decides what the flag means to it.

The three `<workspace>` commands resolve that argument to an existing directory before they start —
a filesystem path or a `file:` URI — and exit 2 naming it when it reaches none. Without that a CI
step whose path has rotted builds nothing, reports whatever documents the head contributes
independently of the workspace, and exits 0; the count is a property of the head, so it can be
plausibly non-zero and cannot be read as the tell.

**Codegen**

- `generate-transfer-model` — generate a transfer-model TypeScript file from a Langium AST.
  `--ast-file`, `--augmentation-file` and `--out-file` are required, and may come from
  `--config <path>` instead; `--langium-config <path>` derives `--ast-file` from that config's `out`
  directory. `--watch` regenerates on change, and the output-naming flags (`--element-type-name`,
  `--terminals-name`, `--terminals-source-name`, `--skip-type-alias`, `--skip-terminal`,
  `--regen-command`) tune the emitted file.

**Heap analysis**

- `analyze-heap <snapshot>` — Langium-aware V8 heap-snapshot analysis. Its flags (`--out-file`,
  `--json`, `--diff`, `--validate <gt.json>`, `--renderer`, and the drill-down tuning flags) are
  declared alongside every other subcommand's, so an unrecognised one is rejected rather than
  ignored.

**Data-server operations** (`--server "<cmd> [args...]"`)

These spawn a data-server child and talk to it over its protocol. All four also take `--cwd <dir>`
and `--log-level <off|error|warn|info|debug|trace>`.

`--server` has to name an entry that puts the **data** protocol on stdio, which for a scaffolded
project is `lib/data-server-main.js` — `init` emits it, and the `<project-id>-data-server` bin key
points at it. `lib/main.js` is the editor entry: stdio there carries LSP and the data head is a
socket whose port is published over the LSP connection, so pointing `--server` at it answers
`Unhandled method data-server/getProjects` (or, without `--stdio`, exits on "Connection input stream
is not set"). Pass the workspace as the entry's own argument rather than through `--cwd`: `--cwd`
re-roots the child, so a relative entry path would resolve against the workspace — the parser
refuses that combination by name rather than letting the child fail on a bare module-not-found.
An absolute entry path works with `--cwd`.

```bash
hydranium-cli projects --server "node ./lib/data-server-main.js ./models"
```

- `projects` — list the projects the server exposes, one JSON envelope per line.
- `query --uri <uri>` — print that document's envelope as a single JSON line.
- `save --uri <uri> --content <text|@file>` — update and persist the document; an `@`-prefixed value
  reads the content from a file. `--client-id <id>`. This is the only writing subcommand, and it
  spawns a data server of its own: a workspace has a **single writer**, so pointing it at one an
  editor already has open is two writers and the later write wins. Neither process will see a
  half-written file, but nothing serialises them either, so a lost write is the documented
  outcome rather than a defect — the guarantee, its one exception and what it does not cover are
  in [Status: one process writes a workspace](../../docs/adopting/status.md#one-process-writes-a-workspace).
- `watch --uri <uri>` — subscribe to document updates and print events as NDJSON until Ctrl-C.
  `--client-id <id>`.

## `init` in detail

`init` writes a project you can build immediately, and it writes **only inside the target
directory** — it refuses a non-empty directory without `--force`, and it never edits a surrounding
manifest (a root `workspaces` entry is printed, not added). It also does **not** run `npm install`
or `langium generate`; both are printed as next steps.

Project options are position-free:

- `<target-dir>` and `--name <Name>` are required. `--name` is the PascalCase **project** name and
  drives the shared generated symbols (`<Name>AstReflection`, `<Name>GeneratedSharedModule`).
- `--heads <list>` picks the protocol heads from `lsp`, `data`, `glsp`; default `lsp,data`. `lsp` is
  mandatory — it owns the workspace, the build pipeline and the shared tier the others read through.
- `--monorepo` scaffolds a member of the surrounding npm workspace, `--scope <@scope>` sets the npm
  scope, `--public` drops the emitted `"private": true`, `--force` allows a non-empty directory.

The emitted manifest carries `files` (`lib`, `src`, `syntaxes`), a derived `description` and
`keywords`, and an empty `author` for you to fill. It is `"private": true` unless you pass
`--public`, because it also declares `"license": "UNLICENSED"` — a scaffold cannot pick a licence for
your project, and a package that grants no rights has no business being publishable to a public
registry. Choose a licence, then pass `--public`. The wizard asks this on every run rather than
letting a default settle it. `files` is not cosmetic: without it npm falls back
to the `.gitignore` the scaffold also writes, which ignores `lib/` — so a publish would ship `main`
and omit the `bin` targets beside it, and succeed. There is deliberately no `repository`: a scaffold
cannot know yours, and tooling follows that field rather than merely displaying it.

There is one `bin` key per executable entry — `<project-id>` for `src/main.ts`, plus
`<project-id>-data-server` for `src/data-server-main.ts` when `data` is in `--heads`. Both sources
begin with a `#!` line, because npm sets the exec bit on a linked target without adding one: a
first line that is anything else is handed to the shell.

Grammar options are **repeatable and order-scoped**: each applies to the `--grammar` it follows.

- `--grammar <Name>` — the PascalCase grammar name; pass it once per grammar. Defaults to `--name`.
- `--extensions <list>` — comma-separated file extensions for that grammar, leading dot optional;
  accumulates. Defaults to the kebab-cased grammar name.
- `--language-id <id>` — override that grammar's derived routing key.
- `--diagram` — scaffold a GLSP diagram for that grammar; requires `glsp` in `--heads`.

Leave `--name` off on an interactive terminal and `init` prompts instead, then echoes the command it
composed before running it — so the wizard is a way to reach an `init` command line, not an
alternative to one. Without a TTY a missing `--name` stays an error, so CI never hangs.

```bash
# Scaffold, install, build
npx @hydranium/cli init ./my-lang --name MyLang
cd my-lang
npm install
npm run build                # langium generate + tsc, into lib/
npm test                     # the scaffolded DI-composition test

# The editor entry: LSP on stdio, every other head on a published socket
node lib/main.js --stdio

# The data head alone, on stdio — the entry the four --server subcommands spawn
hydranium-cli projects --server "node ./lib/data-server-main.js ./models"

# Drive the rest of the CLI against the built factory
npx hydranium-cli reflect      --services ./lib/services.js
npx hydranium-cli lint-grammar --services ./lib/services.js
npx hydranium-cli validate     --services ./lib/services.js ./models
npx hydranium-cli model-docs   --services ./lib/services.js --out-file model-reference.md

# Several grammars, three heads, one of them with a diagram
npx @hydranium/cli init ./order-flow --name OrderFlow --heads lsp,data,glsp \
   --grammar Domain --grammar Process --diagram \
   --grammar Layout --extensions diagram
```

The scaffold wires only the framework defaults. The seams a real language customizes are walked
beside those defaults in
[`docs/concepts/framework-vs-adopter.md`](../../docs/concepts/framework-vs-adopter.md).

## Entry points

This package declares a two-key `exports` map — the root barrel and the CLI
binary — plus a `main` and a `bin`. The binary key is spelled `./lib/cli.js` and
carries no bare alias: the pairing rule that gives every subpath a `./lib/` twin
runs one way only, and a key already spelled that way resolves under both
resolvers as it stands. A consumer that spawns the binary resolves it by
specifier, and `bin` offers a shim on `PATH` rather than a path.

| Entry            | Kind   | Contents                         |
| ---------------- | ------ | -------------------------------- |
| `hydranium-cli`  | `bin`  | The binary — all 13 subcommands. |
| `@hydranium/cli` | `main` | Programmatic API (see below).    |

The programmatic surface is the part of the CLI worth calling from your own scripts and tests rather
than through argv: `spawnDataServer` / `withDataServer` (spawn a data-server child and get a typed
proxy, with teardown), `generateTransferModel` / `watchTransferModel` (the codegen, as a function),
and the `runProjects` / `runQuery` / `runSave` / `runWatch` command bodies.

## Status

Alpha — pre-v0, not yet published. The subcommand surface and the programmatic API are both still
moving. See the [repository README](../../README.md) for the current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](../../NOTICE.md) for third-party notices.
