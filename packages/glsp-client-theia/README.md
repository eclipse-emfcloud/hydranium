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
  `HydraniumHiddenBoundsUpdater`, and `HydraniumGlspMessageService`. Each
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
  **`AbstractHydraniumGlspDiagramManager`** derives the language-correlated
  getters from one descriptor plus a label.
- **`HydraniumGlspClientContribution`** — for a server that starts late: it tails
  the Output channel for a server-printed ready marker and defers `start` until a
  workspace is open.
- **Backend (`./node`)** — `GlspServerConnectionHandler` (the socket bridge,
  plugging in `@eclipse-glsp/theia-integration`'s `SocketConnectionForwarder`) and
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
| `@theia/core`                     | `^1.71.0`     |
| `@theia/output`                   | `^1.71.0`     |
| `@theia/process`                  | `^1.71.0`     |
| `@theia/workspace`                | `^1.71.0`     |
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

| Subpath     | Holds                                                                                                                                                                                                                       | Environment                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `.`         | Re-exports `./browser` — the larger of the two tiers and safe to load anywhere.                                                                                                                                              | browser-neutral (gated)          |
| `./browser` | The frontend module bases, `createGlspClientTheiaModule`, the dispatcher, loader, widget, bounds updater, message service, diagram manager and configuration bases, `NoOpExternalMarkerManager`                               | browser / Theia frontend (gated) |
| `./node`    | `GlspServerConnectionHandler`, `createGlspConnectionContainerModule`                                                                                                                                                         | Node / Theia backend             |
| `./testing` | `makeBindRecorder`, the GLSP-module-specific Inversify double (the cross-head doubles live in `@hydranium/client-theia/testing`)                                                                                              | browser-neutral (gated)          |

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
