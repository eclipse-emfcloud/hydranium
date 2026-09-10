# `@hydranium/data-client-theia`

Theia client primitives for the hydranium **data head** — the companion of
`@hydranium/data-server` in the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework.

The data head's frontend speaks the data server's own `vscode-jsonrpc` protocol
over a channel that the Theia backend relays byte-for-byte onto the server's
socket. This package is both halves of that arrangement: the browser-side
connection and typed-frontend bases, and the backend-side connection handler and
forwarder. Install it if a Theia application needs form editors, trees, or
code-gen driven from the live AST rather than from LSP text edits.

## What it gives you

- **`openChannelConnection`** with `createChannelConnection` and
  `ChannelConnectionHandle` — wraps a Theia `Channel` as a `vscode-jsonrpc`
  `MessageConnection`, gated on a `whenReady` promise, and by default
  re-establishes it by **re-opening the channel** when the connection is lost.
  Re-opening rather than rebuilding is what recovers a restarted language server:
  a server restart closes only the multiplexed sub-channel, so no replacement
  channel ever arrives on its own. Retries follow `DEFAULT_RECONNECT_DELAYS`,
  escalating per consecutive loss and resetting after
  `RECONNECT_ESCALATION_RESET_MS`.
- **`AbstractDataServiceFrontend`** — base for a frontend that owns the
  data-server connection: the workspace-gated connect, the typed server proxy,
  the inbound client binding, and a lazy idempotent init gate (`ensureConnected`).
  You supply the connection seams (`connectionProvider`, `servicePath`,
  `methodNamespace`, `client`, `clientMethods`); progress UI and domain caching
  layer on top.
- **`AbstractDiagnosticsDataServiceFrontend`** and
  **`AbstractReferencesDataServiceFrontend`** — the same base specialised for the
  two protocol fragments an adopter most often keeps: each diagnostics
  (`dumpServerState`, `writeHeapSnapshot`, `dumpPodMemory`, the profiling and
  latency calls) and each reference method is implemented as a readiness-gated
  pass-through, so you do not hand-write identical one-line bodies. They are
  deliberately independent bases rather than chained.
- **`EmitterDataClient`** (on `./common`, not `./browser`) — the default
  client-side implementation of the data protocol's inbound notifications,
  fanning each one out to a Theia `Event`: `onDidUpdateDocument`,
  `onDidSaveDocument`, `onDidChangeProjects`. Bind an instance as the
  `localTarget` of the frontend's RPC proxy. It sits on the common tier because
  its only runtime dependency is `@theia/core`'s root entry, which is Theia's own
  common tier, so a backend or a plain-Node consumer can bind it too.
- **`whenWorkspaceOpen`** — resolves once Theia reports a workspace root. The data
  server only starts once the LSP launches for a workspace, so connecting earlier
  would hang in port discovery; pass this as `whenReady`.
- **Backend (`./node`)** — `DataServerConnectionHandler` (the socket bridge, with
  its own GLSP-free `SocketChannelForwarder`),
  `createDataServerConnectionContainerModule(...handlers)` for the
  frontend-scoped module boilerplate, and `HostDiagnosticsServer` with
  `createHostDiagnosticsBackendModule()` — which, paired with the browser-side
  `bindHostDiagnostics`, lights up the "Backend" diagnostics commands in
  `@hydranium/client-theia`'s contribution.

## Install

```bash
npm install @hydranium/data-client-theia
```

You must already have a Theia application with `@theia/workspace` available, and a
running hydranium data server to connect to. The declared peer dependencies are:

| Peer                      | Range                |
| ------------------------- | -------------------- |
| `@hydranium/client-theia` | `^1.0.0-next`        |
| `@hydranium/core`         | `^1.0.0-next`        |
| `@hydranium/protocol`     | `^1.0.0-next`        |
| `@theia/core`             | `^1.70.0`            |
| `@theia/workspace`        | `^1.70.0`            |
| `inversify`               | `^6.0.0`             |
| `vscode-jsonrpc`          | `^8.0.0 \|\| ^9.0.0` |

`@hydranium/core` is reached only from the `./node` tier (the host-diagnostics
service), so a frontend-only consumer never loads it.

## Wiring

This package declares no `theiaExtensions` — it is a library your own Theia
extension builds on. That extension's `package.json` declares the entries, and
each entry names one frontend/backend module pair:

- the **frontend** module binds your `AbstractDataServiceFrontend` subclass (and,
  for the diagnostics commands, calls `bindHostDiagnostics`);
- the **backend** module is typically a one-liner:
  `export default createDataServerConnectionContainerModule(MyHandler)`, where
  `MyHandler` extends `DataServerConnectionHandler`.

More than one handler is the normal case, not an exotic one. Theia keys a
frontend channel by its service path and refuses a second channel on a path
already open, so every frontend abstraction reaching the data head needs its own
`servicePath` — while the shared `portCommand` still names the one server process
behind them all.

The refusal is silent, which is what makes it expensive: the loser's promise is
left unsettled rather than rejected, so a frontend that shared a path hangs on
its loading state indefinitely with nothing in the server log to say why.

## Entry points

| Subpath     | Holds                                                                                                                                                                                                | Environment                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `.`         | Nothing — the surface is split by environment, so the root barrel stays empty.                                                                                                                        | browser-neutral (gated)          |
| `./common`  | `EmitterDataClient` — a module lands here only when values, types and relative imports are all neutral or Theia COMMON tier. No error-reconstruction bridge, and that is a property of the transport: the direct `vscode-jsonrpc` connection carries a typed error across the relay natively. | browser-neutral (gated)          |
| `./browser` | `openChannelConnection`, `createChannelConnection`, the three `Abstract*DataServiceFrontend` bases, `bindHostDiagnostics`, `whenWorkspaceOpen`                                                         | browser / Theia frontend (gated) |
| `./node`    | `DataServerConnectionHandler`, `createDataServerConnectionContainerModule`, `SocketChannelForwarder`, `HostDiagnosticsServer`, `createHostDiagnosticsBackendModule`                                    | Node / Theia backend             |

Every subpath also has a `./lib/<name>` twin for consumers on
`moduleResolution: "Node"`. "Gated" means the repository's neutral-bundle check
enforces that the entry bundles for the browser with no `node:*` import,
transitive ones included; `./node` is deliberately outside that gate. Also
worth reading: [what "gated neutral" does and does not promise](../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).

## Status

Alpha — pre-v0, not yet published. The API is not stable and may change without a
deprecation cycle. See [`docs/concepts/architecture.md`](../../docs/concepts/architecture.md) for
the data head's place among the heads, and the
[repository README](../../README.md) for current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
runtime dependency closure are collected in the repository
[`NOTICE.md`](../../NOTICE.md).
