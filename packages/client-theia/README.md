# `@hydranium/client-theia`

Cross-head Theia client primitives for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework.

This is the host-coupled layer every hydranium head shares when it runs inside a
Theia application: the Output-channel logger, the log-threshold preference
binding, the memory-diagnostics command set, and the backend base class that
bridges a Theia frontend channel to a server socket. It carries no head-specific
dependency — `@hydranium/data-client-theia` and `@hydranium/glsp-client-theia`
both build on it. Install it if you are assembling a Theia extension around a
hydranium server; a non-Theia host does not need it.

## What it gives you

- **`ChannelLogger`** with `bindChannelLogger` — writes frontend log lines into a
  Theia Output channel, formatted to interleave with the server's own log so both
  sides of the conversation read as one transcript. The same call also binds
  `ChannelTracer`, the `Tracer` token frontend services inject when they time
  something.
- **`LogLevelPreferenceContribution`** with `bindLogLevelPreference` — applies the
  framework log threshold from a Theia preference once per application, and keeps
  it in sync on change. It is a `FrontendApplicationContribution` on purpose: the
  threshold is process-global, so applying it from a per-diagram container would
  leak one preference listener per container.
- **`MemoryDiagnosticsContribution`** with `bindMemoryDiagnostics` — the whole
  diagnostics command set, parameterised by three branding strings
  (`MemoryDiagnosticsOptions`: `commandIdPrefix`, `category`, `channelName`):
  Dump Server State, Dump Pod Memory, Dump Frontend State, Write Heap Snapshot
  (Server), Start / Stop Profiling (Server), Record Performance Profile, and Dump
  RPC/LSP Latency. Two more — Dump Backend State and Write Heap Snapshot
  (Backend) — register only when the optional `HostMemoryDiagnosticsService` is
  bound. You bind `MemoryDiagnosticsService` to your own connected data-server
  frontend; the framework cannot, because that class is yours.
- **`captureBrowserRuntime` / `formatBrowserRuntime`** — the renderer's own memory
  reading as a `BrowserRuntimeReport`, preferring the standardized
  `performance.measureUserAgentSpecificMemory()` and falling back to Chromium's
  coarse `performance.memory`.
- **`AbstractSocketForwardingConnectionHandler`** (Node side) — the abstract base for the
  Theia _backend_ half of a head's transport. It discovers the server's listening
  port by executing a registered command, opens a `net.Socket`, and relays bytes
  between the frontend channel and it. The one abstract hook is which byte
  forwarder bridges the two; port discovery, connect orchestration, and the
  buffer-and-replay fix for frontend writes that arrive before the forwarder is
  wired all live here.
- **`./testing`** — `makeStubOutputChannelManager` and `makeStubInversifyContext`,
  the doubles that let the pieces above be unit-tested without a Theia
  application.

## Install

```bash
npm install @hydranium/client-theia
```

You must already have a Theia application (or a Theia extension inside one). The
declared peer dependencies are:

| Peer                  | Range         |
| --------------------- | ------------- |
| `@hydranium/protocol` | `^1.0.0-next` |
| `@theia/core`         | `^1.71.0`     |
| `@theia/output`       | `^1.71.0`     |
| `inversify`           | `^6.0.0`      |

`@theia/output` is easy to miss: the memory-diagnostics commands and the channel
logger both write to an Output channel, so a host that does not already depend on
it has to add it.

## Wiring

This package is a **library, not a Theia extension** — it declares no
`theiaExtensions`, so dropping it into an application wires nothing on its own.
Your own extension package declares the `theiaExtensions` entries and imports
from here:

- a **frontend** module (a `ContainerModule` in the extension's `browser/` tier)
  calls the `bind*` helpers — `bindChannelLogger`, `bindLogLevelPreference`,
  `bindMemoryDiagnostics` — and binds `MemoryDiagnosticsService` to your
  data-server frontend;
- a **backend** module (the extension's `node/` tier) registers a
  `AbstractSocketForwardingConnectionHandler` subclass as a Theia `ConnectionHandler`. In
  practice you subclass one of the head-specific subclasses shipped by
  `@hydranium/data-client-theia` or `@hydranium/glsp-client-theia` rather than
  this base directly.

## Entry points

| Subpath     | Holds                                                                                                                                                                                                            | Environment                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `.`         | Nothing. Deliberately empty, so an environment-specific import cannot reach the wrong bundle through a barrel.                                                                                                    | browser-neutral (gated)          |
| `./browser` | `ChannelLogger`, `ChannelTracer`, `LogLevelPreferenceContribution`, `MemoryDiagnosticsContribution`, the `bind*` helpers, `captureBrowserRuntime`                                                                 | browser / Theia frontend (gated) |
| `./node`    | `AbstractSocketForwardingConnectionHandler` and its options — imports `node:net`                                                                                                                                          | Node / Theia backend             |
| `./testing` | `makeStubOutputChannelManager`, `makeStubInversifyContext`                                                                                                                                                        | browser-neutral (gated)          |

Every subpath also has a `./lib/<name>` twin, so a consumer on
`moduleResolution: "Node"` can reach it. "Gated" means the entry is enforced
browser-neutral by the repository's neutral-bundle check: it must bundle for the
browser with no `node:*` import, including transitive ones — and [what "gated neutral" does and does not promise](../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).
`./node` is deliberately not gated — that tier is where Node-only code belongs.

## Status

Alpha — pre-v0, not yet published. The API is not stable and may change without a
deprecation cycle. See [`docs/concepts/architecture.md`](../../docs/concepts/architecture.md) for
how the Theia client tier relates to the heads, and the
[repository README](../../README.md) for current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE). Third-party notices for the
runtime dependency closure are collected in the repository
[`NOTICE.md`](../../NOTICE.md).
