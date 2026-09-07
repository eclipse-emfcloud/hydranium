# Per-head module maps

A navigation aid: the key modules of each head package and how they wire. It
complements — does not repeat — [`architecture.md`](architecture.md) (what the
heads *are* and how they share one workspace) and
[`conventions.md`](../contributing/conventions.md) (the patterns the modules follow:
role-names, the `./node` boundary, registration contributions, DI tokens). Read
those for the "why"; read this to find your way around a package. References
name a file + symbol (grep for the symbol); verify against source before relying
on a load-bearing claim.

The three provided heads map onto packages per the naming rule (a thin head is
folded into its cross-head package as a subpath — see `conventions.md`
"Head-omission marks the cross-head member"):

| head | package | subpath / note |
| --- | --- | --- |
| LSP (textual) | `@hydranium/core` | folded in at `core/lsp` — overrides on Langium-LSP |
| data-server (typed JSON-RPC) | `@hydranium/data-server` | + wire contract at `@hydranium/protocol/data` |
| GLSP (graphical) | `@hydranium/glsp-server` | built on `@eclipse-glsp/server` |

---

## `@hydranium/core` — the shared runtime + LSP head

`core` is the framework's spine: the shared Langium workspace runtime (the single
source of truth) plus the thin LSP head folded in at `/lsp`. Its entry subpaths
are `.` (neutral runtime), `./lsp` (LSP head), `./node` (server-only — may import
`node:*`), `./testing`, `./testing/node` (test scaffolding needing a filesystem
or a Node transport) and `./testing/playwright`; `jq '.exports|keys' packages/core/package.json`
is the enumeration, and it also shows the `./lib/*` twin each one carries. The
`.` root barrel (`src/index.ts`) re-exports every `langium/**/index.ts`.

### Top-level `src/` folders

| folder | subpath | role |
| --- | --- | --- |
| `langium/` | `.` | the framework core (see subfolders below) |
| `documents/` | `.` | Model-coordination: `AstDocumentManager` (multi-client lifecycle), `HydraniumTextDocuments`, `WritableFileSystemProvider`, `LanguageClientTextShadow`, `SelfSaveRegistry` (the server's own writes, so the watched-files echo can be suppressed) |
| `launcher/` | `.` | server / integrated-server lifecycle handles |
| `util/` | `.` | shared primitives (`Registry`, `environment.ts` capability accessors) |
| `lsp/` | `./lsp` | the LSP head — `HydraniumCompletionProvider` and `AbstractHydraniumSemanticTokenProvider` (language module), `HydraniumDocumentUpdateHandler` (shared module: Langium declares that slot on the shared tier), `instrumentLspConnection` (opt-in per-method timing, applied to the `Connection` before the services factory sees it), plus a re-export of `startLanguageServer` |
| `node/` | `./node` | server-only: Node filesystem provider, log-file sink, socket launcher (`startSocketServer`/`publishPortOnLspConnection`), monitors, the CLI-backing fns (`validateWorkspace`/`reflectGrammar`/`lintGrammar`/…) |
| `testing/` | `./testing` | Langium-layer doubles + `makeTestServices` / `makeFakeDocument`; the runtime-bound half splits out into `testing/node/` (`./testing/node`, the in-process LSP harness, the subprocess `startSpawnedServer`, and anything needing a filesystem) and `testing/playwright/` (`./testing/playwright`) so the `.`-adjacent `./testing` entry stays browser-neutral |

### `langium/` subfolders (the semantics layered onto the AST)

| subfolder | owns | skill |
| --- | --- | --- |
| `ast-extension/` | computed/synthetic AST properties (`AstExtensionService`, `makeAstNodeBuilder`) | `hydranium-grammar-ast` |
| `scope/` | scope provider, scope computation, candidate provider, AST-node-description provider (tier factories), reference builder, scope-extension, tier primitives | `hydranium-grammar-ast` + `hydranium-scope-references` |
| `naming/` | `NameProvider` (three qualification levels) + name-separator validation | `hydranium-scope-references` |
| `project/` | project tier (`ProjectManager`, `SingleProjectManager`, `AbstractProjectManager`) | `hydranium-build-pipeline` |
| `document-builder/` | `HydraniumDocumentBuilder`, `BuildPipelineIntegration` | `hydranium-build-pipeline` |
| `build-phase-pass/` | batch-level pass registry (`BuildPhasePassService`) | `hydranium-build-pipeline` |
| `integrity/` | AST-integrity rule runner + `IntegrityPhase` | `hydranium-build-pipeline` |
| `residency/` | CST-residency memory policy (`CstResidencyService`) | `hydranium-build-pipeline` |
| `model-service/` | in-process workspace facade (`ModelService`) | `hydranium-data-server` |
| `transfer/` | AST↔transfer-model encoder (`TransferEncoder`) | `hydranium-data-server` |
| `serialization/` | `Serializer` slot + YAML serialization | — |
| `validation/` | document validator + validation-check collector | — |
| `keys/` | `ElementKeyProvider` (identity axis) | `hydranium-glsp-server` |
| `labeling/` | `LabelProvider` (UI display axis) | — |
| `update-rewrite/` | structured-write rewrite registry (`UpdateRewriteService`) | — |
| `config/` | settings / config surface | `hydranium-observability` |
| `diagnostics/` | logger/tracer naming (`LogNameOptions`), log preamble | `hydranium-observability` |
| `documentation/` | `HydraniumCommentProvider` — read-side CST rehydration, so a hover/completion doc comment resolves from a shed `$cstNode` | `hydranium-grammar-ast` |
| `workspace/` | workspace manager, synthetic-node + virtual-document helpers, document-URI policy, index manager, workspace lock, the `LangiumDocumentFactory` override | `hydranium-grammar-ast` |

### How it wires

`bootstrapLangium(shared, language)` (`langium/bootstrap.ts`) registers a
language on `shared.ServiceRegistry`, asserts core slots bound, and eager-
constructs `DEFAULT_EAGER_SERVICES`. Two DI modules compose the tree:
`createServerSharedModule` (`langium/module.ts`, shared slots incl.
`DocumentBuilder`/`ProjectManager`/`BuildPipelineIntegration`/
`AstDocumentManager`) and `createServerLanguageModule`
(`langium/language-module.ts`, per-language slots + the contribution groups
`ast`/`references`/`integrity`/`validation`/`updateRewrite`). The soft
`core`/`lsp` boundary (a head needing the workspace ready depends on the *core*
`HydraniumWorkspaceManager.workspaceInitialized`, not the LSP protocol head) is
covered in `conventions.md` "Soft `core` / `lsp` boundary".

---

## `@hydranium/data-server` — typed JSON-RPC head

A small package: one head class plus one host seam. It consumes an already-built
`MessageConnection` and the shared services tree; the socket launcher lives in
`@hydranium/core/node`, not here — but the package has a `./node` subpath of its
own, for the one capability that cannot be portable.

### `src/` layout

| module | subpath | role |
| --- | --- | --- |
| `data-server.ts` | `.` | `DataServer<TTransfer, TDiagnostic, TProject>` + option types — the head itself |
| `diagnostics-provider.ts` | `.` | `DataServerDiagnosticsProvider` — the host-supplied seam for heap snapshots, profiling, pod memory and server state. It exists so the portable entry never takes a static `@hydranium/core/node` import, which would make the head unbundleable for a browser over methods a browser cannot call |
| `default-diagnostics.ts` / `.browser.ts` | `.` | the platform default behind that seam. `package.json`'s `browser` field swaps the first for the second, so a browser build never follows the Node import; the browser default rejects with a message naming the capability rather than returning an empty snapshot that reads as "the server is fine" |
| `node/` | `./node` | the real Node implementation of the seam (`nodeDataServerDiagnostics`), computed in *this* process because the data-server child is the one holding the model store |
| `index.ts` | `.` | barrel; re-exports the head and the diagnostics seam (testing stays out of the production bundle) |
| `testing/` | `./testing` | `makeDataServerHarness` — reachable only via `@hydranium/data-server/testing` |

### The wire contract lives in `protocol`

The typed surface is `@hydranium/protocol/data` (`protocol/src/data/`): the
role-explicit fragments (`DocumentServerProtocol` / `ProjectServerProtocol` →
`DataServerProtocol`; the `*ClientProtocol` notification fragments →
`DataClientProtocol`), the drift-proof method-name lists, and the wire/port
constants (`DATA_SERVER_WIRE_PREFIX`, `DATA_SERVER_PORT_COMMAND`). The generic
RPC machinery (`createRpcProxy` / `bindRpcMethods`) is in `protocol/src/rpc/`.

### How it wires

`new DataServer(connection, services, options)` (`data-server.ts`) pulls
`TransferEncoder` + `ModelService` from `services.model`, then a single
`createRpcProxy` call builds the outbound `DataClientProtocol` proxy AND
registers the inbound `DataServerProtocol` handlers (via `localTarget`/
`localMethods`). Lifecycle requests forward to `ModelService` and encode at the
wire boundary; it subscribes to `DocumentBuilder`/`TextDocuments`/`ProjectManager`
for push notifications. Detail + gotchas: the `hydranium-data-server` skill.

---

## `@hydranium/glsp-server` — graphical head

Built on `@eclipse-glsp/server`. The `.` entry is neutral (bare
`@eclipse-glsp/server`); `./node` carries the socket bringup
(`@eclipse-glsp/server/node`) and `./browser` the web-worker one
(`@eclipse-glsp/server/browser`). This is the one head with a third subpath,
because GLSP's launcher, app module and readiness signal all differ per
platform. Translation to the diagram model (the GModel factory) is adopter-side,
bound per `DiagramModule` — there is no framework GModel factory.

### `src/` folders

| folder | subpath | role |
| --- | --- | --- |
| `launcher/` | `.` | `HydraniumGlspAppModule` (DI app-module + `configureAdditionalBindings` hook) and `AbstractHydraniumGlspDiagramModule` — the abstract `DiagramModule` base an adopter subclasses to declare which grammar a diagram type edits, plus the `bindDiagramLanguage` binder it applies; the framework-overrides module both bringups share is deliberately not re-exported |
| `node/` | `./node` | `startGlspServer` (socket launcher, GLSP `SocketServerLauncher`) |
| `browser/` | `./browser` | `startGlspServerInWorker` (web-worker launcher, GLSP `WorkerServerLauncher`, on a transferred `MessagePort`) |
| `state/` | `.` | base state classes (`AbstractHydraniumGlspState`, `Reconciling…`, `FullText…`), `HydraniumGlspIndex`, the `HydraniumTypes` DI token registry |
| `storage/` | `.` | `HydraniumGlspStorage` (load/save + settle/parse-error seams) + `SaveConflictPolicy` |
| `submission/` | `.` | `HydraniumGlspSubmissionHandler` (readyEvent-gated submit) |
| `command/` | `.` | `HydraniumGlspRecordingCommand` — the operation-handler seam (no base handler class) |
| `dispatcher/` | `.` | `HydraniumGlspServerActionDispatcher` (timing + direction) |
| `computed-bounds/` | `.` | `HydraniumGlspComputedBoundsActionHandler` — handshake-aware override of GLSP's `ComputedBoundsActionHandler` |
| `validation/` | `.` | LSP-diagnostics → GLSP-markers (`HydraniumGlspModelValidator`, `diagnosticsToMarkers`) |
| `logging/` | `.` | `GlspClientLogger` (`LspLogger` → GLSP `Logger`) |
| `util/` | `.` | `serviceIdentifier` Inversify-token helper |
| `testing/` | `./testing` | `makeGlspHarness` + `makeNoopGlspLogger`/`makeCapturingGlspLogger` |

### How it wires

`startGlspServer(options)` (`node/start-glsp-server.ts`) builds the app
`Container`, loads the framework `defaultAppModule` (`HydraniumGlspAppModule`,
which binds the `HydraniumTypes.*` tokens against the shared services) + adopter
`appModules`, resolves GLSP's `SocketServerLauncher`, and listens.
`startGlspServerInWorker(options)` (`browser/start-glsp-server-in-worker.ts`)
mirrors that structure over `WorkerServerLauncher` and drops the socket
lifecycle; its `context` is a required transferred `MessagePort`. Per diagram
open, `HydraniumGlspStorage` loads the document, the adopter GModel factory
renders it, and user operations run through `HydraniumGlspRecordingCommand` back
into the shared AST. Detail + gotchas: the `hydranium-glsp-server` skill.

---

## See also

- [`architecture.md`](architecture.md) — the heads + shared workspace (the "why").
- [`conventions.md`](../contributing/conventions.md) — role-names, the `./node` boundary,
  registration contributions, GLSP DI tokens, package naming.
- [`build-pipeline-registries.md`](build-pipeline-registries.md) — the phase grid
  the `document-builder`/`build-phase-pass`/`integrity` modules implement.
- [`framework-vs-adopter.md`](framework-vs-adopter.md) — the scope/naming seams.
- `.claude/skills/hydranium-*` — two different audiences share this prefix. The
  per-surface skills linked above describe a framework seam and are read while
  changing it; the rest interpret the artefacts of a profiling run and depend on
  a captured session rather than on this repository, so they answer nothing
  about the module maps here. A skill's own description says which it is.
