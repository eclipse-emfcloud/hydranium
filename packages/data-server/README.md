# `@hydranium/data-server`

The typed JSON-RPC data head of [hydranium](../../README.md): it exposes the live
Langium AST to non-LSP clients — form editors, tree views, code generators — as
an adopter-defined transfer model over a `vscode-jsonrpc` `MessageConnection`.
Installed by the server process that already composes
[`@hydranium/core`](../core); a client needs only
[`@hydranium/protocol`](../protocol).

## What it gives you

- **One class, `DataServer`.** `new DataServer(connection, services, options)`
  self-wires: a single `createRpcProxy` call registers the inbound
  `DataServerProtocol` handlers and builds the outbound `DataClientProtocol`
  proxy on the same wire. It contributes no shared-tier DI bindings — it reads
  exclusively from `ServerSharedServices`, so there is no shared module to
  compose.
- **A document lifecycle over the shared workspace:** `openModelDocument`,
  `getModelDocument`, `updateModelDocument`, `saveModelDocument`,
  `closeModelDocument`, `watchModelDocument` / `unwatchModelDocument`, and
  `waitForReady` for clients that must not race workspace initialisation.
- **Push notifications instead of polling:** `onDocumentUpdated` when a
  subscribed document reaches the configured build phase
  (`DataServerOptions.subscriptionPhase`, `DocumentState.Validated` by default),
  `onDocumentSaved` on a separate channel, and `onProjectsChanged` from the
  project registry.
- **Projects as first-class:** `getProjects` and `getProjectForUri`, answered from
  the framework's `ProjectManager`.
- **An opt-in reference/naming slice** — `findReferenceCandidates`,
  `resolveReference`, `findNextName` — implemented here but deliberately outside
  the `DataServerProtocol` composition, so a pure data consumer does not pay for
  it. Compose `ReferenceServerProtocol` onto the connection explicitly.
- **A diagnostics seam,** `DataServerDiagnosticsProvider`, with the Node
  implementation `nodeDataServerDiagnostics()` behind `./node` so the portable
  entry keeps bundling for a browser.

The projection itself is not this package's: it delegates to `TransferEncoder`
and `ModelService` from `@hydranium/core`, so there is no second in-memory model
to keep in sync.

## Install

```bash
npm install @hydranium/data-server
```

This package bundles no runtime dependencies. Its peers must be present:
`@hydranium/core`, `@hydranium/protocol`, `@hydranium/langium`, `vscode-jsonrpc`
and `vscode-languageserver-textdocument`. You must already have a composed
hydranium shared services tree and a `MessageConnection` — the socket and stdio
launchers live in `@hydranium/core/node`, not here.

## Exports

| subpath     | holds                                                                                                          | platform                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.`         | `DataServer` and its option types, plus the `DataServerDiagnosticsProvider` seam — the whole production surface. | browser-neutral                   |
| `./node`    | `nodeDataServerDiagnostics()`, the runtime-backed half of the diagnostics seam.                                 | Node-only                         |
| `./testing` | `makeDataServerHarness` — a real server driven in-process over a duplex connection pair.                        | Node-only (`vscode-jsonrpc/node`) |

`.` is gated as browser-neutral in CI (`scripts/check-neutral-bundles.mjs`). It
stays that way through a `browser` field in `package.json` that swaps the
diagnostics default for a browser twin, so a bundler never follows the
`@hydranium/core/node` import a Node host resolves — see [what "gated neutral" does and does not promise](../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).
Each subpath also has a `./lib/…` twin for consumers on
`moduleResolution: "Node"`.

## Getting oriented

Construct the head after the shared services tree exists and keep the returned
instance for `dispose`; it registers its handlers on the connection you pass and
subscribes to the document builder, the text-document store and the project
manager for its push notifications. The typed contract a client codes against —
`DataServerProtocol`, `DataClientProtocol`, the drift-proof method-name lists and
the port constants — lives in `@hydranium/protocol/data`, and the generic
`createRpcProxy` / `bindRpcMethods` machinery in `@hydranium/protocol`. The four
distinct meanings of "document" this head sits between are worth reading first:
[`docs/concepts/document-layers.md`](../../docs/concepts/document-layers.md). See
also [`docs/concepts/architecture.md`](../../docs/concepts/architecture.md) and
[`docs/concepts/head-module-maps.md`](../../docs/concepts/head-module-maps.md).

## Status

Alpha — pre-v0, not yet published. The API is not stable and may change without a
deprecation cycle. See the [repository README](../../README.md) for the current
status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
repository are recorded in [`NOTICE.md`](../../NOTICE.md).
