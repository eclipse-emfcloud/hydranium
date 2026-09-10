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

## The `theiaExtensions` entries

The first three are frontend/backend pairs, and each is **separately loadable** —
a deployment that wants properties without a diagram loads only the second. The
fourth is backend-only.

| Frontend module                              | Backend module                            | What it adds                                                       |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `order-flow-process-diagram-frontend-module` | `order-flow-glsp-backend-module`          | the `.process` diagram, over the GLSP head's socket                |
| `order-flow-properties-frontend-module`      | `order-flow-data-server-backend-module`   | the properties panel, over the data head                           |
| `order-flow-memory-diagnostics-frontend-module` | `order-flow-host-diagnostics-backend-module` | the diagnostics / profiling commands, under the `Order Flow` category |
| —                                            | `order-flow-localization-backend-module`  | the German catalogue, so the framework's messages render in another language |

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

## Translating the framework's messages

The framework **externalizes user-facing strings and never translates them**: each
carries a stable `hydranium/<unscoped-package>/<name>` code beside its English
text, and the side that knows the reading user's locale renders it. This example
is where that gets exercised, and `src/nls/order-flow.de.json` is the whole
opt-in.

**One catalogue covers both framework layers**, because Theia flattens a nested
catalogue by joining keys with `/` — the separator the codes already use:

- **host-bound** strings (`hydranium/client-theia/*`) the Theia frontend resolves
  itself through `nls.localize`;
- **identity-side** ones (`hydranium/protocol/*`) that the framework only attaches
  an identity to, reaching a user through `OrderFlowTheiaDataPort.reportError`,
  which hands `nls.localization?.translations` to `renderFrameworkMessage`.

Adopter-owned codes (`order-flow/*`) live in the same file under their own
namespace — `hydranium/` is reserved for the framework.

To see it, use Theia's **Configure Display Language** command and pick German,
then reload. The locale lives in `localStorage['localeId']`; nothing on the
backend selects one, and nothing can — a Theia backend serves every connected
frontend at once, which is why the framework holds no locale and leaves the
render to this side.

**The catalogue is deliberately partial**, and that is the demonstration rather
than an oversight: an untranslated code falls back to its English default, so an
adopter can translate as little as they like — or nothing, and never learn the
mechanism exists. Running in German therefore shows German palette entries beside
English ones, which is what a half-finished translation honestly looks like.

**Diagnostics are translated in the properties panel.** `TransferDiagnostic`
carries `code` **and** `params`, so `hydranium/core/separator-in-name` — the
framework's one validation diagnostic, which interpolates a name and a separator
— renders complete in German there. `OrderFlowTheiaDataPort.renderDiagnostic`
does the render, from `TransferDiagnostic.resolved` plus Theia's loaded
catalogue, and the form takes it through the optional `renderDiagnostic` handler
so the VS Code webview keeps showing the server's English unchanged.

The **squiggle, hover and Problems tree stay English**, and that is a decision
rather than a gap: Monaco's marker model has no field for the params, so the
only route is a rebound `ProtocolToMonacoConverter` — a Theia internal that
would need re-checking at every version bump. So for an editor-surface
diagnostic, prefer a parameterless sentence.

**Two Theia requirements that fail silently**, both fixed here and both worth
copying if you register a catalogue of your own:

- Register with a `LanguageInfo` carrying `languagePack: true`, not a bare
  `'de'`. Without it *Configure Display Language* never offers the language and
  the frontend preload discards the catalogue and resets to the default.
- Import the JSON rather than reading a `__dirname`-relative path. A Theia
  backend is webpack-bundled into the *application's* `lib/backend/main.js`,
  where `__dirname` is the app directory — the read fails with `ENOENT` and
  leaves the frontend stuck at its splash.

`test/order-flow-localization.test.ts` guards the one failure runtime cannot: a
key naming no real code. Theia falls back to English on a miss, so a typo and a
deliberate omission are indistinguishable when the app runs.
`test/order-flow-localization-contribution.test.ts` drives the contribution
through Theia's own registry and provider, which is what catches the two
requirements above — neither is visible in the catalogue file.

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
