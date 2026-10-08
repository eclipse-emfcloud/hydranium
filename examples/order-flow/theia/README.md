# `@hydranium/example-order-flow-theia`

The **Theia extension** for the order-flow example: it mounts the `.process`
GLSP diagram, puts a properties panel into Theia's own Properties view, and
registers the framework's memory-diagnostics commands. It is a library, not an
application: [`../theia-app`](../theia-app/README.md) is the app that loads it.

Read it beside [Host in Theia](../../../docs/guides/host-in-theia.md), which
walks you through the same steps for your own language. Most files here are a
subclass that names a few strings, because the Theia-side mechanisms ship in
`@hydranium/client-theia`, `@hydranium/data-client-theia` and
`@hydranium/glsp-client-theia`.

## The `theiaExtensions` entries

The first three are frontend/backend pairs, and each is **separately
loadable**: a deployment that wants properties without a diagram loads only the
second. The fourth is backend-only, and the fifth adds a `frontendPreload`
module to its pair, because its rebinds must land before Theia builds its
connection.

| Frontend module                              | Backend module                            | What it adds                                                       |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `order-flow-process-diagram-frontend-module` | `order-flow-glsp-backend-module`          | the `.process` diagram, over the GLSP head's socket                |
| `order-flow-properties-frontend-module`      | `order-flow-data-server-backend-module`   | the properties panel, over the data head                           |
| `order-flow-memory-diagnostics-frontend-module` | `order-flow-host-diagnostics-backend-module` | the diagnostics / profiling commands, under the `Order Flow` category |
| —                                            | `order-flow-localization-backend-module`  | the German catalogue, so the framework's messages render in another language |
| `order-flow-connection-frontend-module`, plus `order-flow-connection-preload-module` | `order-flow-connection-backend-module` | reconnect hardening on both sides, and the connection log in an Output channel |

## Where to look

| Concern                                  | Files                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the data head's transport                | [`order-flow-theia-data-port.ts`](src/browser/order-flow-theia-data-port.ts): a `ChannelDataPort` that names its service path                             |
| one connection shared by panel and commands | [`order-flow-data-connection.ts`](src/browser/order-flow-data-connection.ts)                                                                           |
| the properties panel                     | [`order-flow-properties-view-provider.ts`](src/browser/order-flow-properties-view-provider.ts), [`order-flow-properties-widget.ts`](src/browser/order-flow-properties-widget.ts), [`order-flow-selection-uri.ts`](src/common/order-flow-selection-uri.ts) |
| the diagram                              | [`order-flow-process-diagram-frontend-module.ts`](src/browser/order-flow-process-diagram-frontend-module.ts), [`order-flow-glsp-client-contribution.ts`](src/browser/order-flow-glsp-client-contribution.ts) |
| the port command ids                     | [`order-flow-diagram-language.ts`](src/common/order-flow-diagram-language.ts), pinned by [`order-flow-host-port-commands.test.ts`](test/order-flow-host-port-commands.test.ts) |
| translations                             | [`order-flow.de.json`](src/nls/order-flow.de.json), [`order-flow-localization-backend-module.ts`](src/node/order-flow-localization-backend-module.ts) |

## The port commands, and the one silent failure

The backend forwarders reach each head's port through a **host command** the
VS Code extension registers at runtime (`order-flow.port.dataServer`,
`order-flow.port.glsp`) — not through the LSP request ids the server answers.
They are restated in `src/common/order-flow-diagram-language.ts` because a Theia
extension cannot import from a VS Code extension package without dragging
`vscode` into its build.

Get one wrong and nothing errors:
`AbstractSocketForwardingConnectionHandler` defaults `findPortAttempts` to `-1`
and retries forever. `test/order-flow-host-port-commands.test.ts` pins the
naming rule against the server's own request ids, which it _can_ import.

## Translations

Two German catalogues, one per side that renders a message:
[`src/nls/order-flow.de.json`](src/nls/order-flow.de.json) for what this
frontend renders, and
[`../server/src/nls/order-flow.de.json`](../server/src/nls/order-flow.de.json)
for what the server renders. How the split works, and how to do the same for
your language, is in
[Translate your language](../../../docs/guides/translate-your-language.md).

To try it, run **Configure Display Language**, pick German and reload. Then type
a reference to something that does not exist: the diagnostic reads in German.

## Building and testing

```bash
npm --prefix examples/order-flow/theia run build
npm --prefix examples/order-flow/theia test          # typecheck:test + vitest
npm --prefix examples/order-flow/theia run watch
npm --prefix examples/order-flow/theia run lint
```

There is nothing to run here. To see any of it, build and start
[`../theia-app`](../theia-app/README.md); `npm run start:order-flow` from the
repo root does both.

**Stylesheet import order matters.** The shared sheet from
`@hydranium/example-order-flow-client` is imported first and this package's own
second, so the `--theia-*` values behind each colour role can override.
