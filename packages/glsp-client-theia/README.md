# `@hydranium/glsp-client-theia`

The Theia integration for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) GLSP head, the
companion of `@hydranium/glsp-server`. Install it to mount a Hydranium diagram
in a Theia application. It builds on `@eclipse-glsp/theia-integration` and
`@hydranium/client-theia`.

## What it gives you

- A diagram mounted from one subclass of
  `AbstractHydraniumGlspTheiaFrontendModule`.
- Load failures shown on the diagram with a Retry, and logged to the Output
  channel beside the diagram's action traffic.
- A client that waits for a workspace, and starts again after a failed start
  or a lost connection.
- Unsaved diagram changes kept across a reload or a reconnect, while the server
  stays the same.
- Problems listed once when the LSP head reports them too.
- The backend handler that relays the channel to the GLSP server's socket.

## Install

```bash
npm install @hydranium/glsp-client-theia
```

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
| `vscode-jsonrpc`                  | `^9.0.0`      |

## Wiring

This package declares no `theiaExtensions`; your own Theia extension declares
them, one frontend and backend pair per diagram.

- The frontend entry exports `new MyDiagramModule()`, where `MyDiagramModule`
  extends `AbstractHydraniumGlspTheiaFrontendModule` and names the diagram's
  language, configuration and manager. Return a subclass of
  `HydraniumGlspClientContribution` from its `bindClientContribution()`, and
  set its `logLevelPreference` to have it bind the log level preference.
- Your diagram configuration extends
  `AbstractHydraniumGlspDiagramConfiguration` and calls
  `createGlspClientTheiaModule` from its `configureContainer`, not from the
  frontend module: called earlier, GLSP's own bindings silently replace its
  rebinds. Set `propagateMarkersToProblemsView` to `false` when the LSP head
  already reports the same problems.
- One frontend module calls `bindEditorDiskSync` from
  `@hydranium/client-theia`, since a diagram save writes a file an editor can
  have open.
- The backend entry exports `createGlspConnectionContainerModule(MyHandler)`,
  where `MyHandler` extends `GlspServerConnectionHandler`.

The widget imports its own stylesheet, so your bundler needs a CSS loader,
which a Theia application has.

For the whole setup, see *Host in Theia* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath                       | Use it for                                           | Runs in         |
| ----------------------------- | ---------------------------------------------------- | --------------- |
| `.`                           | The same as `./browser`                              | Theia frontend  |
| `./browser`                   | The frontend module, configuration and manager bases | Theia frontend  |
| `./node`                      | The connection handler and its backend module        | Theia backend   |
| `./testing`                   | A binding recorder for testing your modules          | browser-neutral |
| `./style/diagram-loading.css` | The loading overlay's stylesheet, imported for you   | browser         |

The subpaths need a TypeScript `moduleResolution` that reads `exports`
(`NodeNext` or `Bundler`); see *Requirements* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Status

Alpha: every release is a prerelease that may break the API, so pin an exact
version. Guides and known limitations:
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](https://github.com/eclipse-emfcloud/hydranium/blob/main/NOTICE.md)
for third-party notices.
