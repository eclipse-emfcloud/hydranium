# `@hydranium/glsp-client-theia`

Theia client primitives for the hydranium **GLSP head** — the companion of
`@hydranium/glsp-server` in the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework.

It sits between `@eclipse-glsp/theia-integration` and an adopter's diagram: the
module composition, the instrumented dispatcher and bounds updater, the loading
overlay, the marker-propagation switch, and the backend socket bridge. Install it
if you are mounting a hydranium GLSP diagram in a Theia application.

## What it gives you

- **`AbstractHydraniumGlspTheiaFrontendModule`** — a `GLSPTheiaFrontendModule`
  subclass that absorbs the overrides every adopter otherwise writes verbatim.
  You declare `diagramLanguage`, `diagramConfiguration` and `diagramManager`;
  optionally set `logLevelPreference` (the base then binds the log-threshold
  contribution for you) and override `bindClientContribution()` — returning
  `SkipClientContribution` for a secondary diagram type that shares a server with
  a primary one.
- **`createGlspClientTheiaModule(context, options)`** — the standard per-diagram
  bindings, all unconditional: the cross-head `ChannelLogger`,
  `HydraniumGlspActionDispatcher`, `HydraniumDiagramLoader`,
  `HydraniumHiddenBoundsUpdater`, `HydraniumGlspMessageService`, and
  `HydraniumStatusOverlay`, which keeps GLSP's status overlay on the page after
  sprotty's first render replaces the diagram's base div. Each
  replaces a GLSP default with a strict superset of its behaviour, so a head that
  wants the original rebinds that one token back.
- **Loading feedback that cannot silently vanish.** `HydraniumDiagramLoader`
  catches every load failure — the dispatcher-init, connect and first
  `RequestModelAction` steps upstream leaves unwrapped — routes it to the Output
  channel, and reports it as an error `StatusAction`. It publishes a terminal
  `DiagramLoadOutcome`, which `HydraniumGlspDiagramWidget` keys its opaque canvas
  overlay on (`DIAGRAM_LOADING_CLASS`, `DIAGRAM_LOADING_FAILED_CLASS`).
  `HydraniumGlspMessageService` then drops the now-redundant "Model loading in
  progress" toast (`MODEL_LOADING_PROGRESS_TITLE`) and forwards every other
  progress report untouched.
- **Instrumentation.** `HydraniumGlspActionDispatcher` logs action traffic into
  the shared Output channel and pairs requests with responses — by id, or by kind
  for the GLSP flow actions that carry none (`HYDRANIUM_DEFAULT_LOGGED_KINDS`,
  `HYDRANIUM_DEFAULT_KIND_PAIRS`, extensible via
  `HydraniumGlspActionDispatcherOptions`). `HydraniumHiddenBoundsUpdater` emits
  one trace line per bounds request with the measured element count and the raw
  `getBBox` cost — the client-side phase that scales with rendered elements
  rather than model size.
- **`AbstractHydraniumGlspDiagramConfiguration`** with
  `propagateMarkersToProblemsView` — set it `false` for a head whose co-resident
  LSP already publishes the same diagnostics, and the per-diagram container binds
  `NoOpExternalMarkerManager` instead: markers still decorate the diagram, but
  Theia's Problems view stops double-listing them.
- **`AbstractHydraniumGlspDiagramManager`** derives the language-correlated
  getters from one descriptor plus a label, and `reopen` replaces a diagram
  with a fresh widget in the same tab position, as the Retry of a failed load
  does. It reopens every diagram when their client is lost, and a failed one
  when a client starts. A diagram's client id is the same for the same widget
  in the same window, so a diagram reopened after its client is lost, or
  reloaded with its page, takes its old session over with the window's resume
  token and keeps its unsaved text.
- **`WindowSessionService`** — the window's id and resume token, claimed as
  the frontend starts. The default keeps them in `sessionStorage` and hands
  them on only as the page leaves, so a reload resumes and a duplicated tab
  draws its own. Rebind it for a different notion of a window.
- **`HydraniumGlspClientContribution`** — for a server that starts late: it
  defers `start` until a workspace is open, fails a start that takes longer than
  `startupTimeoutMs` (30 s by default), and starts a fresh client after a failed
  start or a lost connection, after a delay that grows while clients keep
  failing, reporting each attempt through `client-theia`'s
  `ConnectionReporter`. `onDidStartClient` and `onDidLoseClient` announce each
  client, and each start and loss is logged to the application-scope
  `ChannelLogger` an adopter binds with `bindChannelLogger`. Its client is
  `HydraniumGlspClient`, which ends a session without the server once the
  connection is gone.
- **`HydraniumGlspSaveable`** — the diagram widget's saveable. Each save is a
  `RequestSaveModelAction` the server answers: the save resolves on its own
  response, and rejects on its own rejection or after 10 s rather than GLSP's
  2 s. It stays dirty while a save is pending, so Theia's exit check still
  counts it. The server answers through
  `HydraniumGlspRequestSaveModelActionHandler`, which
  `AbstractHydraniumGlspDiagramModule` registers; against a server that does
  not advertise the request, the saveable behaves as GLSP's does. The dirty
  flag follows the server, so an edit whose dirty state has not arrived when
  Save All runs is not saved. Under the `fire-and-forget` `SaveDeliveryPolicy`
  the server answers before the disk write finishes, and answers a failed
  write as saved.
- **Backend (`./node`)** — `GlspServerConnectionHandler` (the socket bridge,
  over `@hydranium/client-theia`'s `SocketChannelForwarder`) and
  `createGlspConnectionContainerModule(handler)` for the frontend-scoped module
  boilerplate.

## Install

```bash
npm install @hydranium/glsp-client-theia
```

You must already have a Theia application wired for GLSP — `@eclipse-glsp/client`
and `@eclipse-glsp/theia-integration` are peers, not bundled — and a running
hydranium GLSP server. The declared peer dependencies are:

| Peer                              | Range         |
| --------------------------------- | ------------- |
| `@eclipse-glsp/client`            | `^2.6.0`      |
| `@eclipse-glsp/theia-integration` | `^2.6.0`      |
| `@hydranium/client-theia`         | `^1.0.0-next` |
| `@hydranium/protocol`             | `^1.0.0-next` |
| `@theia/core`                     | `^1.70.0`     |
| `@theia/process`                  | `^1.70.0`     |
| `@theia/workspace`                | `^1.70.0`     |
| `inversify`                       | `^6.0.0`      |
| `snabbdom`                        | `^3.5.1`      |

## Wiring

This package declares no `theiaExtensions` — it is a library your own Theia
extension builds on. That extension declares the entries; a diagram is one
frontend/backend pair:

- the **frontend** entry points at a module that
  `export default new MyDiagramModule()`, where `MyDiagramModule` extends
  `AbstractHydraniumGlspTheiaFrontendModule`. Your `DiagramConfiguration`
  subclass calls `createGlspClientTheiaModule` in its container initialisation,
  passing the `channelLogger` name;
- the **backend** entry is typically
  `export default createGlspConnectionContainerModule(MyHandler)`, where
  `MyHandler` extends `GlspServerConnectionHandler`. The handler's
  `languageContributionId` decides the per-language service path Theia routes
  frontend connections to.

**The `style/` directory needs no action from you.** It holds one stylesheet,
`diagram-loading.css`, for the widget's loading overlay, and the widget module
imports it itself — precisely so an adopter cannot ship an unstyled `div` in
normal flow by forgetting it. It is listed in `files` because it must be present
in the published tarball for that import to resolve; your bundler needs a CSS
loader, which a Theia application's webpack configuration already has. Colours
come from `--theia-*` theme variables, and every rule is overridable from a
stylesheet loaded afterwards.

## Entry points

| Subpath     | Holds                                                                                                                                                                                                            | Environment                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `.`         | Re-exports `./browser` — the larger of the two tiers and safe to load anywhere.                                                                                                                                  | browser-neutral (gated)          |
| `./browser` | The frontend module bases, `createGlspClientTheiaModule`, the dispatcher, loader, widget and its saveable, bounds updater, message service, diagram manager and configuration bases, `NoOpExternalMarkerManager` | browser / Theia frontend (gated) |
| `./node`    | `GlspServerConnectionHandler`, `createGlspConnectionContainerModule`                                                                                                                                             | Node / Theia backend             |
| `./testing` | `makeBindRecorder`, the GLSP-module-specific Inversify double (the cross-head doubles live in `@hydranium/client-theia/testing`)                                                                                 | browser-neutral (gated)          |

Every subpath also has a `./lib/<name>` twin for consumers on
`moduleResolution: "Node"`. "Gated" means the repository's neutral-bundle check
enforces that the entry bundles for the browser with no `node:*` import,
transitive ones included; `./node` is deliberately outside that gate. Also
worth reading: [what "gated neutral" does and does not promise](../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).

## Status

Alpha — pre-v0, not yet published. The API is not stable and may change without a
deprecation cycle. See [`docs/concepts/architecture.md`](../../docs/concepts/architecture.md) for
the GLSP head's place among the heads, and the
[repository README](../../README.md) for current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
runtime dependency closure are collected in the repository
[`NOTICE.md`](../../NOTICE.md).
