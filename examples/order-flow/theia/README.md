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

The framework **externalizes user-facing strings and selects no locale**: each
carries a stable `hydranium/<unscoped-package>/<name>` code beside its English
text, and the side that knows the reading user's language renders it.

**Two catalogues, split by which side that is** — and their key sets are
disjoint, which a test here asserts, because a message rendered twice has two
authorities over one sentence:

- `theia/src/nls/order-flow.de.json` — what **this frontend** renders: the
  host-bound strings (`hydranium/client-theia/*`) Theia resolves through
  `nls.localize`, and the portable client tier's own (`hydranium/protocol/*`,
  `order-flow/properties/*`) which reach a user through
  `OrderFlowTheiaDataPort.reportError`. Those fire when the data server is
  unreachable, so no server could have worded them. Nested, because Theia
  flattens a catalogue by joining keys with `/` — the separator the codes use.
- `server/src/nls/order-flow.de.json` — what the **server** renders: its
  diagnostics, this example's validation codes, Langium's unresolved-reference
  sentence and chevrotain's unexpected-character one. Flat keys, handed straight
  to `OrderFlowMessageRenderer`, the one binding server-side rendering asks of
  an adopter.

Adopter-owned codes (`order-flow/*`) live under their own namespace in whichever
file renders them — `hydranium/` is reserved for the framework.

To see it, use Theia's **Configure Display Language** command and pick German,
then reload. The locale lives in `localStorage['localeId']`.

**One switch changes both sides.** Theia initializes its plugin host with the
frontend's locale, the sideloaded servers extension runs there, and
`vscode-languageclient` puts `env.language` into LSP `initialize` — so the
server is handed the same locale and renders its own messages before sending
them. Nothing on this *backend* selects a locale, and nothing can: it serves
every connected frontend at once, which is why the locale is declared per
connection rather than held there.

**The catalogue is deliberately partial**, and that is the demonstration rather
than an oversight: an untranslated code falls back to its English default, so an
adopter can translate as little as they like — or nothing, and never learn the
mechanism exists. Running in German therefore shows German palette entries beside
English ones, which is what a half-finished translation honestly looks like.

**Diagnostics reach the squiggle in German**, including a parameterised one.
To see it, type a reference to something that does not exist:
`hydranium/core/unresolved-reference` interpolates a reference type and its
text, and renders complete on the squiggle, the hover, the Problems tree and the
properties panel alike, because the server renders it once and every surface
receives the finished sentence.

The catalogue also translates `hydranium/core/separator-in-name`, which **this
example cannot make fire** — every name here is an `ID` and `ProjectName` admits
only hyphens, so the identifier charset never meets the `.` separator. It is
translated anyway because an adopter cannot know which framework codes their own
grammar will reach, and an untranslated one costs nothing.

That is what moved: rendering these on the client could never reach the editor
surfaces, Monaco's marker model having no field for the params, and the only
route there was a rebound `ProtocolToMonacoConverter` — a Theia internal needing
re-checking at every bump. A server that renders needs none of it, and the
advice to prefer a parameterless sentence for the squiggle retires with it.

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
