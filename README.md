<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hydranium-logo-dark.svg">
    <img src="docs/assets/hydranium-logo.svg" alt="" width="128" height="128">
  </picture>
</p>

<h1 align="center">Hydranium</h1>

A generic, language-agnostic [Langium](https://langium.org/)-based framework
for building modeling-language servers — LSP for textual editing, and a typed
RPC data-server head for non-LSP clients (form editors, diagrams,
code-generators) that need direct access to the live AST.

**Status:** alpha — pre-v0, under active development. Not yet published.

## What this is

`hydranium` provides reusable infrastructure for Langium-powered modeling
languages:

- A pluggable Langium services framework (DI patterns, service registry,
  language-meta-data-keyed lookup).
- A multi-client text-document store (`HydraniumTextDocuments`) that mediates
  concurrent edits from multiple co-editing clients (a textual editor and a
  form editor open on the same document).
- An integrity-rule registry for cross-document validation and constraint
  enforcement.
- A phase-aware AST extension framework (computed properties, synthetic
  children).
- A property-ordered YAML serializer.
- An LSP server head (at `@hydranium/core/lsp`) and a typed JSON-RPC
  **data-server head** (`@hydranium/data-server`) that share one workspace
  and run on one or two transports.
- A GLSP server head (`@hydranium/glsp-server`) for graphical model
  editing on the same AST.

## What this is _not_

Hydranium is **not** [`@eclipse-emfcloud/model-server`](https://github.com/eclipse-emfcloud/model-server)
— the package names land close in the EMF Cloud namespace and the two are
easily confused. The contrast:

- **`@eclipse-emfcloud/model-server`** stores an EMF runtime model and lets
  clients edit it via a CRUD protocol.
- **`hydranium`** wraps a Langium grammar — text on disk is the source of
  truth — and exposes both LSP and a typed RPC head over the same AST. There
  is no EMF runtime; the AST is Langium's, and the wire shape is projected
  from it by an adopter-supplied encoder.

The two address different middle layers and are complementary, not
alternatives.

## Why use this

You're building a domain-specific modeling tool — a UML variant, an ETL
graph, a system-architecture DSL — and you want users to edit it from more
than one UI surface (a text editor, a form editor, a diagram) while keeping
the file on disk authoritative and human-diffable. Without a framework
you'd build a Langium server, bolt on a parallel RPC layer for the
form/diagram clients, then discover that two editors saving the same file
race each other, then build a client-aware document store, then re-discover
that synthetic AST properties need to update at the right Langium document
phase. `hydranium` is the consolidated answer to that pile of accidental
work.

Three things together make up the value proposition; any one on its own is
reproducible, but the combination is not:

1. **A typed, non-LSP data-server head on the same AST.** Form editors,
   tree views, and code-generators get a typed JSON-RPC API
   (`getModelDocument`, update, save, push notifications for document and
   project changes) projected from the live Langium AST by an
   adopter-supplied encoder — no EMF runtime.
2. **Multi-client coordination on one document.** The multi-client
   document store (`HydraniumTextDocuments`, bound at Langium's
   `workspace.TextDocuments` slot) tracks multiple co-editing clients per
   URI with per-client document state, version-author history, and an
   `applyEdit` shadow path for LSP/Monaco clients. This is the hard part most ad-hoc
   Langium adopters re-invent badly.
3. **A graphical head on the same AST** (`@hydranium/glsp-server`).
   Diagram editing shares storage and save with the text and form heads,
   so all three surfaces stay consistent.

Around those, the framework provides the supporting infrastructure you'd
otherwise hand-roll per project: a cross-document integrity-rule registry,
a phase-aware AST-extension service (computed properties, synthetic
children attached at specific Langium document phases), a property-ordered
YAML serializer, transfer-model codegen, and a project/scope tier model.

## Packages

Ten packages, all at v0 and released in lockstep — mixing versions across the
set is unsupported, because several of them share types by identity rather than
by structure.

They are grouped below by the role each name declares. A package name reads
`<head>-<role>-<platform>`, so each head's server and its Theia client sit
together, and a name with no head spans all of them.

| Package | You need it when | Purpose |
| --- | --- | --- |
| **Contracts** | | |
| `@hydranium/protocol` | you write any client | Generic transfer types, RPC primitives, typed protocol contracts. One runtime dependency (`fast-json-patch`) and no Langium — a form editor, tree view or code generator depends on this and nothing else of ours. |
| **Server heads** | | |
| `@hydranium/core` | always, server-side | Framework runtime — DI modules, multi-client text store, AST extensions, integrity rules, project + scope tiers, launcher utilities. The LSP textual head is folded in at the `/lsp` subpath. |
| `@hydranium/data-server` | non-LSP clients read your model | Typed JSON-RPC data-server head (`DataServer`) — read, update and save documents over a `MessageConnection`. |
| `@hydranium/glsp-server` | you want graphical editing | Generic GLSP server framework — storage, submission, computed-bounds, dispatcher, state, command stack. |
| **Client integrations** | | |
| `@hydranium/client-theia` | your host is Theia | Cross-head Theia primitives — Output-channel logger, log-level preference, memory diagnostics, socket-forwarding connection handler. |
| `@hydranium/data-client-theia` | …and you run the data head | Theia-side data-head client wiring — data-service frontend, emitter data client, channel connection, workspace gate. |
| `@hydranium/glsp-client-theia` | …and you run the GLSP head | Theia-side GLSP client wiring — connection handler, dispatcher, diagram widget, module helpers. |
| **Tooling** | | |
| `@hydranium/cli` | always, as a devDependency | Framework CLI (`hydranium-cli`) — scaffold a project (`init`), introspect a grammar (`reflect` / `lint-grammar` / `model-docs`), headless `validate`, transfer-model codegen, and data-server ops (`projects` / `query` / `save` / `watch`). |
| `@hydranium/conformance` | you want the protocol suite | Runner-agnostic conformance kit (TCK) you run against your own server. |
| `@hydranium/langium` | you import Langium at all | The pinned Langium re-export — the single chokepoint adopters import Langium through, so that exactly one physical copy exists in the graph. |

The prebuilt **client libraries are Theia-only** today. VS Code and plain-browser
hosts are demonstrated end to end in `examples/order-flow`, but that wiring is
example code you copy rather than a package you depend on. The protocol packages
are host-neutral, so writing a client for another host is a supported thing to
do — see [`docs/adopting/status.md`](./docs/adopting/status.md).

## Getting started

The fastest path to a working language head is the framework CLI's `init`
scaffolder. It stands up a complete, buildable project — a starter grammar,
the `create<Name>Services` DI wiring, an LSP + data-server launch, and build
scripts — that you then grow into your own language.

> **Hydranium is alpha, and every release is a prerelease.** Releases roll:
> each one is `1.0.0-next.<n>`, where `n` counts commits since the last release
> tag. There is no stable version yet, so `latest` points at the newest
> prerelease and the `npx` lines below resolve to it. **Pin an exact version for
> a reproducible build** — a range like `^1.0.0` matches no prerelease at all,
> so it will not resolve one.

```bash
# Scaffold a new language project
npx @hydranium/cli init ./my-lang --name MyLang

cd my-lang
npm install
npm run build          # langium generate + tsc → lib/
```

Leave `--name` off on a terminal and `init` prompts instead, then **echoes the
command it composed** before running it — so the wizard is a way to reach a
`hydranium-cli init …` line, not an alternative to one. Three answers are worth
knowing about: the file extension, which nothing can derive from a project name
alone (`--name OrderFlow` on its own gives `.order-flow`); whether to join a
surrounding npm workspace, which `--monorepo` also does non-interactively; and
whether the package is publishable, asked on every run because the emission
declares itself `UNLICENSED` and withholds publication to match, so `--public`
is a licence decision rather than a packaging one. In a workspace the scaffold
extends the root tsconfig that carries `compilerOptions` and leaves `.gitignore`
to the root; it never writes outside the target directory, so a root
`workspaces` entry is printed rather than added.

You now have a runnable server (`node lib/main.js --stdio` — LSP + data-server
on one process) and a starter grammar at `src/grammar/my-lang.langium`. Edit
the grammar, re-run `npm run build`, and drive the rest of the CLI headlessly
against the built `createServices` factory (`lib/services.js`):

```bash
# Type hierarchy, terminals, cross-references (Markdown, or --json)
npx hydranium-cli reflect --services ./lib/services.js

# Grammar-convention CI gate (nameable cross-ref targets, entry rule)
npx hydranium-cli lint-grammar --services ./lib/services.js

# Validate a workspace of model files (non-zero exit on errors)
npx hydranium-cli validate --services ./lib/services.js ./models

# Navigable Markdown model reference for your docs
npx hydranium-cli model-docs --services ./lib/services.js --out-file model-reference.md
```

The CLI also carries transfer-model codegen (`generate-transfer-model`) and
data-server operations (`projects` / `query` / `save` / `watch`); run
`npx hydranium-cli --help` for the full surface. Those four drive the data
protocol over a spawned child's stdio, so they take the scaffold's *other*
entry — `--server "node ./lib/data-server-main.js ./models"` — rather than
`lib/main.js`, which gives stdio to LSP.

The scaffold wires only the framework defaults. A real language customizes a
small set of scope / naming / serialization seams — walked side-by-side with
the framework defaults in
[`docs/concepts/framework-vs-adopter.md`](./docs/concepts/framework-vs-adopter.md).
For the manual, un-scaffolded DI composition, see the next section.

## Compose a server — minimal example

The shortest end-to-end composition done by hand: one generated Langium language
wired to the framework's `DataServer` head, talking JSON-RPC over an in-process
duplex pair. This is what `init` scaffolds for you; do it manually when you're
slotting the framework into an existing project. Swap the duplex for stdio or a
socket in a real deployment; nothing else changes. A head with several grammars
repeats step 1's language `inject` per grammar over the one shared tree — see
`createIntegrationServices` below, which is the shape the examples use.

```ts
import { DataServer } from '@hydranium/data-server';
import { createRpcProxy } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol
} from '@hydranium/protocol/data';
import { makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import { bootstrapLangium, createServerSharedModule, createServerLanguageModule, type ServerModuleContext } from '@hydranium/core';
import { EmptyFileSystem, inject } from 'langium';
import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';
import { DomainGeneratedModule, OrderFlowGeneratedSharedModule } from './generated/module.js';
import type { DomainModel } from './generated/ast.js';

// 1. Build the Langium DI tree. The framework's `createServerSharedModule`
//    and `createServerLanguageModule` slot in as ordinary `inject(...)`
//    contributors — they're plain Langium modules, not a separate framework
//    factory layer. Order matters: framework defaults first, adopter
//    overrides last.
const ctx: ServerModuleContext = EmptyFileSystem;
const shared = inject(
   createDefaultSharedModule(ctx),
   OrderFlowGeneratedSharedModule,
   createServerSharedModule(ctx)
   // ...adopter shared module(s) here
);
const language = inject(
   createDefaultModule({ shared }),
   DomainGeneratedModule,
   createServerLanguageModule(ctx)
   // ...adopter language module(s) (must bind `serializer.Serializer`)
);
bootstrapLangium(shared, language);

// 2. Attach the data-server head to a `MessageConnection`. The constructor
//    self-registers request handlers, the outbound notification proxy, and
//    a connection-close teardown listener — no separate `start()` call.
const pair = makeDuplexConnectionPair();
new DataServer<DomainModel>(pair.left, shared);
pair.left.listen();
pair.right.listen();

// 3. Client side: typed proxy over the same wire. One `createRpcProxy`
//    call exposes the server surface outbound and binds `localClient`
//    inbound for push notifications (`onDocumentUpdated` /
//    `onDocumentSaved` / `onDocumentDeleted` / `onDocumentsBuilt` /
//    `onProjectsChanged`).
const localClient: DataClientProtocol<DomainModel> = {
   onDocumentUpdated: event => console.log('updated:', event.document.uri),
   onDocumentSaved: () => {},
   onDocumentDeleted: event => console.log('deleted:', event.uri),
   // Documents rebuilt that this client never watched — re-read anything
   // derived from them.
   onDocumentsBuilt: event => console.log('built:', event.uris.join(', ')),
   onProjectsChanged: () => {}
};
const proxy = createRpcProxy<DataServerProtocol<DomainModel>, DataClientProtocol<DomainModel>>(pair.right, {
   methodNamespace: DATA_SERVER_WIRE_PREFIX,
   localTarget: localClient,
   localMethods: DATA_CLIENT_PROTOCOL_METHODS
});

const response = await proxy.getModelDocument({ uri: 'file:///workspace/orders.domain' });
// `root` is absent when the server has no such document, so the answer is a
// shaped envelope rather than an error and the caller branches on it.
console.log(response.root ? response.root.declarations.length : 'no such document');
```

The pieces a new adopter discovers from the example:

- **Langium services**: `inject(...)`, `createDefaultSharedModule`, `createDefaultModule`.
- **Framework modules**: `createServerSharedModule` / `createServerLanguageModule` —
  Langium modules that bind framework-default slots; adopters compose them
  with their own modules to override.
- **Bootstrap**: `bootstrapLangium(shared, language)` — registers the
  language, asserts the framework's core slots are bound, and eagerly
  constructs the build-pipeline listeners (`DEFAULT_EAGER_SERVICES`;
  pass a third argument to override). No framework-specific facade —
  or use `createIntegrationServices(...)` to fold the whole
  inject-inject-bootstrap chain into one call.
- **Data-server head**: `new DataServer(connection, shared, options?)` — one
  call self-wires the wire surface against the shared services tree.
- **Typed RPC primitives**: `createRpcProxy` (client side — typed server
  proxy outbound plus inbound `localTarget` notification binding in one
  call) and `bindRpcMethods`, both in `@hydranium/protocol`, reusable for
  adopters' own protocol heads. The data-head method names and wire prefix
  come from `@hydranium/protocol/data` (`DATA_SERVER_WIRE_PREFIX`,
  `DATA_CLIENT_PROTOCOL_METHODS`).
- **Transport**: vscode-jsonrpc `MessageConnection` is the only wire
  abstraction — `makeDuplexConnectionPair` (testing-only) or
  `createMessageConnection(reader, writer)` for stdio / sockets in production.

### Production-shaped versions

- **In-tree adopter** — `examples/order-flow/server/`. `src/main.ts` composes
  all three heads on one shared workspace: LSP via Langium's
  `startLanguageServer`, the data server on a socket whose port is published
  over the LSP connection, and the GLSP head alongside.
- **Out-of-tree adopter** — a shipping product consumes `@hydranium/*` in a
  production-shaped composition: an adopter-defined server protocol
  partitioned alongside `DataServerProtocol` under one wire namespace, a
  Theia frontend bridge consuming the typed proxies, and per-adopter
  `ProjectManager` / `Serializer` overrides. That composition is not public,
  so `examples/order-flow` is the one you can read.

## Example languages

**Read `examples/order-flow/server/` if you want to see how to build on this
framework.** Three grammars over one shared tier from one `langium-cli` run —
`.domain` (entities, value types, enumerations; LSP-primary), `.process`
(tasks, gateways, transitions; GLSP-primary) and `.layout` (the layout
overlay) — with cross-grammar references, a two-project sample workspace
demonstrating every visibility tier, integrity rules, a stdlib, and a diagram.
It is the reference adopter and the framework's only multi-grammar one.

Its siblings carry the rest of the surface: `examples/order-flow/client/`
(host-neutral diagram definition and data client), `examples/order-flow/vscode/`
and `examples/order-flow/theia/` + `theia-app/` (the two host shells),
`examples/order-flow/browser/` (the reference browser deployment: all three heads
in one web worker, no Node runtime and no backend), and
`examples/order-flow/workspace/` (the sample workspace).

**Treat an in-repo example as a demonstration, not as evidence.** Every
`examples/**` adopter is written to validate framework pieces by the same hands
as the framework, so it tends to confirm the framework's assumptions rather than
test them — and `hydranium-cli init`'s templates are derived from the reference
example, so its shortcuts propagate to every scaffolded project. Two shapes that
have actually gone wrong this way, worth checking for in anything you copy: a
stdlib that hand-builds an AST past the generated types and skips validation
(author built-ins in the language's own syntax and load them with
`LangiumDocumentFactory.fromString` instead), and a test tier that reaches an
optional-payload API through only one of its branches, leaving the other
apparently covered and in fact untested. When a design question turns on what an
adopter really needs, a shipping out-of-tree adopter is the better oracle.

## Status and limitations

Hydranium is alpha, pre-v0, and not yet published. The known limitations — no
internationalization layer, whole-document data-head updates, an exact Langium
pin, Theia-only client libraries, and a Theia plugin-host semantic-token gap —
are described with their consequences in
[`docs/adopting/status.md`](./docs/adopting/status.md), alongside the versioning policy and the
roadmap.

### Requirement: your project must resolve `vscode-jsonrpc@9`

Installing the framework installs `vscode-jsonrpc@9.0.1` — the Langium chain
pins it exactly — and that release ships an `exports` map with no `main` or
`typings`. So a consuming project must compile with a resolver that reads
`exports`: `moduleResolution` set to `"Bundler"`, `"Node16"` or `"NodeNext"`.
Under classic `"Node"` resolution the build fails with `TS2307: Cannot find
module 'vscode-jsonrpc'` before reaching any Hydranium code.

[`docs/adopting/requirements.md`](./docs/adopting/requirements.md) has the full
picture — why the framework cannot repair this for you, the escape hatch if you
are stuck on classic resolution, and the rest of what a consuming project has
to satisfy.

## Documentation

**[`docs/README.md`](./docs/README.md) is the documentation index**, grouped by
who each page is for. The three entry points:

- [`docs/adopting/`](./docs/adopting/) — building a language on Hydranium:
  [status and limitations](./docs/adopting/status.md), what your project has to
  [satisfy](./docs/adopting/requirements.md), and the failure modes whose
  message [names the wrong layer](./docs/adopting/troubleshooting.md).
- [`docs/concepts/`](./docs/concepts/) — why it is shaped this way:
  [architecture](./docs/concepts/architecture.md) and the
  [customization seams](./docs/concepts/framework-vs-adopter.md) first, then
  scope and visibility, adopter contributions, document layers, the DI scopes,
  the build-pipeline registries, browser hosting and the head module maps.
- [`docs/contributing/`](./docs/contributing/) — working on Hydranium itself:
  [conventions](./docs/contributing/conventions.md),
  [testing](./docs/contributing/testing.md),
  [releasing](./docs/contributing/releasing.md), and the repo's own
  [build failures](./docs/contributing/troubleshooting.md).

## Repository layout

```
hydranium/
├── packages/                   # @hydranium/* packages
├── examples/                   # Reference example languages
├── docs/                       # Architecture, concepts, conventions
├── scripts/                    # Repo gates + the license-header tool
├── internal/                   # Tracked, and excluded from the published tree
└── .github/workflows/          # CI
```

`internal/` holds the work log, the design plans and the maintainer-only
tooling. It is in git, so a clone has it, and it is excluded by directory from
the tree a release is cut from — nothing under it is part of the published
surface or of any package tarball.

## Building

Requires Node 22.13 or newer — the floor `engines.node` declares — and the npm
version the root `packageManager` field names. Nothing installs that npm for
you: npm does not act on the field, and `actions/setup-node` reads it as a
caching hint. [`CONTRIBUTING.md`](./CONTRIBUTING.md#development-setup) has the
one-line install, and why a fresh clone needs `npm install` twice.

```bash
npm ci
npm run build          # framework only — tsc -b across packages/*
npm run build:all      # framework + every example app via turbo
npm test
npm run lint
npm run check          # the full pre-PR gate — see below
```

`npm run check` is an `&&` chain rather than one command, and turbo is only its
first clause. A later `check:*` script can redden after turbo has already
printed `Tasks: N successful`, so read the END of the run, not turbo's summary.
`scripts.check` in `package.json` is the enumeration in force, and the only one
— [`CONTRIBUTING.md`](./CONTRIBUTING.md#the-gate) names the clauses and what
each is for, but does not fix their order.

See [`docs/contributing/testing.md`](docs/contributing/testing.md) for the test strategy, per-package
commands, the Playwright UI e2e, and the on-demand mutation / perf audits.

For local development:

```bash
npm run watch:all      # single tsc -b -w daemon for the framework graph
npm run dev:order-flow # framework watch + the example's Theia/client/server
                       # watches via concurrently — the full loop, one command
```

Then in a second terminal:

```bash
npm --prefix examples/order-flow/theia-app run start
# open http://localhost:3001
```

Releases use [changesets](./docs/contributing/releasing.md) — every PR that changes
behaviour should ship with a `npx changeset` entry.

## Contributing

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the setup, the gate and the commit
conventions, including the Eclipse Contributor Agreement every contribution
needs. The project follows the
[Eclipse Community Code of Conduct](./CODE_OF_CONDUCT.md).

Security vulnerabilities follow the Eclipse Foundation coordinated-disclosure
process rather than the issue tracker — see [`SECURITY.md`](./SECURITY.md).

## License

Licensed under the [MIT License](./LICENSE).

Third-party copyrights are preserved in the headers of the files that carry
them — grep for `^ \* Copyright` to list them.

[`NOTICE.md`](./NOTICE.md) records the third-party notices the dependency
licences require, and the one patch applied to a dependency at install time.

## Trademarks

Eclipse and the Eclipse logo are registered trademarks of the Eclipse
Foundation. GLSP, Theia, EMF, and other product names mentioned herein may be
trademarks of their respective owners.
