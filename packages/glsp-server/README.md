# `@hydranium/glsp-server`

The graphical-editing head of [hydranium](../../README.md): a generic
[GLSP](https://eclipse.dev/glsp/) server, built on `@eclipse-glsp/server`, that
treats the shared Langium AST as its source of truth. Installed by the server
process that already composes [`@hydranium/core`](../core); the translation to
the diagram model is adopter-side, bound per diagram module.

## What it gives you

- **DI composition against the shared workspace.** `HydraniumGlspAppModule` binds
  the `HydraniumTypes` token registry onto an already-composed
  `ServerSharedServices` tree and exposes a `configureAdditionalBindings` hook;
  `AbstractHydraniumGlspDiagramModule` carries the per-diagram half.
- **Base model state, so an adopter binds a factory rather than a lifecycle:**
  `AbstractHydraniumGlspState`, with the ready-made
  `ReconcilingTransferHydraniumGlspState`, `ReconcilingMultiDocumentGlspState`
  and `FullTextHydraniumGlspState` specialisations, plus `HydraniumGlspIndex`
  over the GModel.
- **Load / save against the live AST.** `HydraniumGlspStorage` loads a document
  on diagram open and writes user operations back through the shared model
  coordination layer, with `SaveDeliveryPolicy` deciding whether the save action
  awaits the write. `HydraniumGlspRequestSaveModelActionHandler` answers each
  save the Theia client sends, or rejects it when the save fails; GLSP's own
  save action stays unanswered for other clients.
  `HydraniumGlspRecordingCommand` is the operation-handler seam — the framework
  provides no base handler class.
- **A submission and dispatch lifecycle that waits for the model.**
  `HydraniumGlspSubmissionHandler` gates submit on the readiness event,
  `HydraniumGlspServerActionDispatcher` adds timing and direction to dispatch
  at debug, and `HydraniumGlspComputedBoundsActionHandler` is
  handshake-aware.
- **Diagram diagnostics for free.** `HydraniumGlspModelValidator` and
  `diagnosticsToMarkers` project the language server's diagnostics onto GLSP
  markers, so a validation error shows on the diagram and in the text editor from
  one source.
- **Two bringups from one composition:** `startGlspServer` over a socket at
  `./node`, `startGlspServerInWorker` over a transferred `MessagePort` at
  `./browser`. Both load the same framework overrides and adopter app modules.

## Install

```bash
npm install @hydranium/glsp-server
```

Peers: `@eclipse-glsp/server`, `inversify` and `reflect-metadata` (the DI
runtime — import `reflect-metadata` once at your entry point),
`@hydranium/core`, `@hydranium/protocol`, `@hydranium/langium`,
`vscode-jsonrpc` and `vscode-languageserver-types`. GLSP's protocol comes
through the server, so it shares the server's copy. The only bundled runtime
dependency is `uuid`. You must already have a composed hydranium shared services
tree, a grammar, and a GModel factory of your own — there is no framework GModel
factory.

`@eclipse-glsp/*` depends on `vscode-jsonrpc@8.2.0` exactly, while the Langium
chain under hydranium resolves a 9.x — the line this package declares as its
peer, `^9.0.0` — so an install holds both. Both launchers build their connection
from the framework's copy, so a framework error keeps its code, and send GLSP's
typed messages by method name, so the second copy does not break the head. A
connection you hand GLSP's client yourself, and a typed message your own code
sends over a GLSP connection, need the same: wrap them with `sendByMethodName`
from `@hydranium/protocol`, as
[Requirements](../../docs/adopting/requirements.md) describes.

Each head binds GLSP's launcher token, `SocketServerLauncher` or
`WorkerServerLauncher`, to the framework's launcher before your `appModules`
load. Replace the launcher with `rebind`; a second `bind` makes the token
ambiguous, and the head throws `Ambiguous match found for serviceIdentifier`
when it starts. A replacement extends `HydraniumGlspSocketServerLauncher` or
`HydraniumGlspWorkerServerLauncher`: GLSP's own launchers build their
connection from GLSP's copy, so framework errors lose their code, and GLSP's
typed messages throw `Unknown parameter structure auto` where its packages
nest separate copies. A replacement that overrides `createConnection` passes
`createGlspConnectionLogger(this.logger)` as the connection's logger, as the
framework's launchers do, or the connection's faults leave no trace.

## Exports

| subpath     | holds                                                                                                                                                                                     | platform        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `.`         | Composition and the head itself: app / diagram modules, state, storage, submission, command, dispatcher, computed-bounds, validation, logging, `serviceIdentifier`.                       | browser-neutral |
| `./browser` | `startGlspServerInWorker`, `BrowserGlspServerOptions`, `HydraniumGlspWorkerServerLauncher`, `createGlspWorkerLauncherModule` — the web-worker bringup on GLSP's `WorkerServerLauncher`.   | browser-only    |
| `./node`    | `startGlspServer`, `GlspServerOptions`, `StartedGlspServer`, `HydraniumGlspSocketServerLauncher`, `createGlspSocketLauncherModule` — the socket bringup on GLSP's `SocketServerLauncher`. | Node-only       |
| `./messages`| Every user-facing message the package raises, by code — what a translation catalogue keys on.                                                                                             | browser-neutral |
| `./testing` | `makeGlspHarness`, `makeNoopGlspLogger`, `makeCapturingGlspLogger`.                                                                                                                       | browser-neutral |

This is the one head with three platform subpaths, because GLSP's launcher, app module and
readiness signal all differ per platform. `.` and
`./testing` are
gated as browser-neutral in CI (`scripts/check-neutral-bundles.mts`), which
depends on `.` naming only the bare `@eclipse-glsp/server` specifier: a slip back
to a `/node` subpath in the portable tree fails that gate. `./browser` is
browser-only rather than neutral — no portability is claimed for it. What the
gate does and does not promise is [what "gated neutral" does and does not promise](../../docs/contributing/design/browser-hosting.md#what-gated-neutral-does-and-does-not-promise).
Resolve the subpaths with [a resolver that reads
`exports`](../../docs/adopting/requirements.md#a-resolver-that-reads-exports);
`"Node"` (node10) reaches none of them.

## Getting oriented

Build the app container, load `HydraniumGlspAppModule` plus your own app modules,
and hand the result to `startGlspServer` (or `startGlspServerInWorker`, whose
`context` is a required transferred `MessagePort` whose page end connects
through `createMessagePortTransport`). Per diagram open, storage
loads the document, your GModel factory renders it, and each user operation
edits a working copy of the source root, written back to the shared document
once when the operation completes, after which the GModel is re-derived and
every listener on that document is notified. The worker bringup and its two bundler
accommodations are in
[Host in a browser](../../docs/guides/host-in-a-browser.md); the
framework/adopter seams are in [Adopting Hydranium](../../docs/ADOPTING.md).
The Theia-side client wiring lives in `@hydranium/glsp-client-theia`.

For the adopter path from a read-only projection to a writable diagram, see [Make a diagram editable](../../docs/guides/editable-diagram.md). It follows the per-diagram module, operation-handler, and shared-services boundaries.

## Status

Alpha — pre-v0, published as a `1.0.0-next` prerelease on every merge to `main`.
The API is not stable and may change without a deprecation cycle. See the
[repository README](../../README.md) for the current status and known
limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
repository are recorded in [`NOTICE.md`](../../NOTICE.md).
