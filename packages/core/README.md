# `@hydranium/core`

The framework runtime of [hydranium](../../README.md): the shared Langium
workspace an adopter's modeling-language server is built from, plus the LSP
textual head folded in at the `/lsp` subpath. Every adopter server installs it,
and so does every other head package (`@hydranium/data-server`,
`@hydranium/glsp-server`).

## What it gives you

- **A composable services tree.** `createServerSharedModule` and
  `createServerLanguageModule` supply the shared- and language-tier DI slots;
  `bootstrapLangium` registers a language on the shared `ServiceRegistry`,
  asserts the core slots are bound, and eager-constructs the services that must
  exist before the first build.
- **Semantics layered onto the AST** that an adopter would otherwise rewrite per
  language: tiered scoping (`HydraniumScopeProvider`,
  `ReferenceCandidateProvider`), qualified naming (`NameProvider`), computed and
  synthetic properties (`AstExtensionService`), AST-integrity rules
  (`IntegrityRule`, `IntegrityRuleRegistry`), batch build passes
  (`BuildPhasePassService`), and a CST-residency memory policy
  (`CstResidencyService`).
- **A build pipeline you can hook by phase.** `HydraniumDocumentBuilder` and
  `BuildPipelineIntegration` dispatch work at Langium `DocumentState` phases,
  while the project tier (`ProjectManager`) discovers and groups documents.
- **Multi-client document coordination.** `AstDocumentManager`,
  `HydraniumTextDocuments`, `WritableFileSystemProvider` and `SelfSaveRegistry`
  generalise the LSP document lifecycle to several co-editing heads, so an edit
  made on one surface is observable on the others without a head-to-head
  synchronisation protocol.
- **The projection the non-LSP heads build on:** `ModelService` (the in-process
  workspace facade), `TransferEncoder` (AST → transfer model), and the
  `Serializer` slot.
- **The LSP head at `./lsp`:** `startLanguageServer`,
  `createLspServerSharedModule` / `createLspServerLanguageModule`,
  `HydraniumCompletionProvider`, `HydraniumDocumentUpdateHandler`, and
  `AbstractHydraniumSemanticTokenProvider`.

## Install

```bash
npm install @hydranium/core
```

Nothing is bundled for you — the peers must be present in the consuming project:

- `@hydranium/protocol` (the wire contract) and `@hydranium/langium` (the pinned
  Langium re-export). Import Langium through `@hydranium/langium` so the whole
  workspace resolves one physical copy of it.
- `vscode-jsonrpc`, `vscode-languageserver`, `vscode-languageserver-protocol`,
  `vscode-languageserver-textdocument`, `vscode-languageserver-types`.
- `@playwright/test` — optional, and needed only for `./testing/playwright`.

The single bundled runtime dependency is `diff`. You also need a Langium grammar
and its generated AST already in place; `hydranium-cli init` scaffolds both.

## Exports

| subpath               | holds                                                                                                                                                                                                       | platform        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `.`                   | The head-neutral framework core: DI modules, AST semantics, build pipeline, model coordination.                                                                                                              | browser-neutral |
| `./lsp`               | The LSP textual head — `startLanguageServer`, its two DI modules, and the Langium-LSP overrides.                                                                                                             | browser-neutral |
| `./node`              | Server-only: `DefaultFileSystemProvider` / `NodeFileSystem`, `startStdioServer`, `startSocketServer`, `publishPortOnLspConnection`, and the headless tools `validateWorkspace` / `reflectGrammar` / `lintGrammar`. | Node-only       |
| `./testing`           | Langium-layer doubles plus `makeTestServices` and `makeFakeDocument`.                                                                                                                                        | browser-neutral |
| `./testing/node`      | Test support that needs a real filesystem, a stream transport or a child process: scratch workspace, golden corpus, `makeLspHarness`, `startSpawnedServer`.                                                  | Node-only       |
| `./testing/playwright`| Playwright fixtures for end-to-end profiling and server-log capture.                                                                                                                                        | Node-only       |

The browser-neutral entries are gated in CI (`scripts/check-neutral-bundles.mjs`
bundles them for the browser and fails on a `node:*` import, including a
transitive one) — see [what "gated neutral" does and does not promise](../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).
Each subpath also has a `./lib/…` twin, so a consumer on
`moduleResolution: "Node"` can reach it.

Importing `./node` has two deliberate side effects at module load: it installs
the `node:fs`-backed log-file sink and the `node:async_hooks`-backed write-lock
reentrancy check, both of which the neutral tree can only declare.

## Getting oriented

A server composes one shared services tree per process and one language module
per grammar, then hands that tree to whichever heads it wants to run. The
worked, compiling version of that composition is in the
[repository README](../../README.md#compose-a-server--minimal-example); the
layering behind it is described in
[`docs/concepts/architecture.md`](../../docs/concepts/architecture.md), and
[`docs/concepts/head-module-maps.md`](../../docs/concepts/head-module-maps.md) is
the module-by-module map of this package. The class-role naming, the `./node`
boundary and the registration-contribution pattern the services follow are in
[`docs/contributing/conventions.md`](../../docs/contributing/conventions.md).

## Status

Alpha — pre-v0, not yet published. The API is not stable and may change without a
deprecation cycle. See the [repository README](../../README.md) for the current
status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
repository are recorded in [`NOTICE.md`](../../NOTICE.md).
