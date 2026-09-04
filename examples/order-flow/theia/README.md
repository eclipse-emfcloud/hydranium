# `@hydranium/example-order-flow-theia`

The **Theia extension** for the order-flow example: it mounts the `.process`
GLSP diagram, contributes a document-scoped properties panel into Theia's own
Properties view, and registers the framework's memory-diagnostics commands. It
is a library, not an application — [`../theia-app`](../theia-app/README.md) is
the app that loads it.

**What this package demonstrates is how little an adopter writes.** Every
Theia-side mechanism it needs already ships in `@hydranium/client-theia`,
`@hydranium/data-client-theia` and `@hydranium/glsp-client-theia`, so most files
here are a subclass that names three strings. That claim is only checkable
against a shell that does nothing else, which is what this one is.

## The three `theiaExtensions` entries

Each is a frontend/backend pair, and each is **separately loadable** — a
deployment that wants properties without a diagram loads only the second.

| Frontend module                              | Backend module                            | What it adds                                                       |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `order-flow-process-diagram-frontend-module` | `order-flow-glsp-backend-module`          | the `.process` diagram, over the GLSP head's socket                |
| `order-flow-properties-frontend-module`      | `order-flow-data-server-backend-module`   | the properties panel, over the data head                           |
| `order-flow-memory-diagnostics-frontend-module` | `order-flow-host-diagnostics-backend-module` | the diagnostics / profiling commands, under the `Order Flow` category |

Four things here are worth reading, because each is a decision rather than
wiring:

- **`OrderFlowTheiaDataPort` is the whole host-specific half of the properties
  panel**, and it is short: in a Theia frontend the client _is_ the RPC
  endpoint, so opening the transport is one `openChannelConnection` call. The
  VS Code shell needs an extension-side hop, a messenger and a `postMessage`
  transport to reach the same place. Everything above the port — `DataSession`,
  `OrderFlowPropertiesModel`, `PropertiesForm` — is shared verbatim with that
  shell.
- **Two service paths, one data server.** The panel and the diagnostics
  frontend each need their own service path and their own backend forwarder,
  because Theia refuses a second channel on a path already open — see
  [`@hydranium/data-client-theia`](../../../packages/data-client-theia/README.md)
  for what sharing one costs.
- **The panel goes into Theia's built-in Properties view**, claiming a selection
  only when it names an order-flow document. No selection glue is contributed:
  the navigator, the tab bar and the open GLSP diagram all publish a selection
  this provider can read.
- **`OrderFlowGlspClientContribution` holds the client back until a workspace is
  open, then tails an Output channel for a server-printed ready marker.** In the
  Theia deployment the server is launched by a _sideloaded VS Code extension_,
  so connecting eagerly would dial a server that has not started.

## The port commands, and the one silent failure

The backend forwarders reach each head's port through a **host command** the
VS Code extension registers at runtime (`order-flow.port.dataServer`,
`order-flow.port.glsp`) — not through the LSP request ids the server answers.
They are restated in `src/common/order-flow-diagram-language.ts` because a Theia
extension cannot import from a VS Code extension package without dragging
`vscode` into its build.

Get one wrong and nothing errors: `AbstractSocketForwardingConnectionHandler` defaults
`findPortAttempts` to `-1` and retries forever.
`test/order-flow-host-port-commands.test.ts` pins the naming rule against the
server's own request ids, which it _can_ import.

## Building and testing

```bash
npm --prefix examples/order-flow/theia run build
npm --prefix examples/order-flow/theia test          # typecheck:test + vitest
npm --prefix examples/order-flow/theia run watch
npm --prefix examples/order-flow/theia run lint
```

Two things that cost time if unknown:

- **There is nothing to run here.** To see any of it, build and start
  [`../theia-app`](../theia-app/README.md) (`npm run start:order-flow` from the
  repo root does both).
- **Stylesheet import order is load-bearing.** The shared sheet from
  `@hydranium/example-order-flow-client` is imported first and this package's
  own second, so the `--theia-*` values behind each colour role can override.
