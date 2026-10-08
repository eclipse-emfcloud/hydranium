# `@hydranium/data-client-theia`

The Theia connection for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) data head, the
companion of `@hydranium/data-server`. Install it when forms, trees or views in
a Theia application work on the live model rather than on text. It builds on
`@hydranium/client-theia`.

## What it gives you

- A data connection in the Theia frontend: you subclass `ChannelDataPort`, and
  the connection and sessions from `@hydranium/protocol` run over it.
- A connection that waits for a workspace, and reconnects on its own when the
  channel is lost, a restarted server included.
- Sessions that end with the page, and a page held while one of them saves.
- The backend handler that relays the channel to the data server's socket.
- Diagnostics commands for the Theia backend process, beside the server's.

## Install

```bash
npm install @hydranium/data-client-theia
```

| Peer                      | Range         |
| ------------------------- | ------------- |
| `@hydranium/client-theia` | `^1.0.0-next` |
| `@hydranium/protocol`     | `^1.0.0-next` |
| `@theia/core`             | `^1.70.0`     |
| `@theia/workspace`        | `^1.70.0`     |
| `inversify`               | `^6.0.0`      |
| `vscode-jsonrpc`          | `^9.0.0`      |

## Wiring

This package declares no `theiaExtensions`; your own Theia extension declares
them and binds from here.

- In a frontend module, subclass `ChannelDataPort` with a `servicePath` and
  bind it in singleton scope. Call `bindDataConnection` for the connection
  over it.
- In the same frontend, call `bindChannelLogger` from
  `@hydranium/client-theia`, and its `bindEditorDiskSync`, since a data server
  save writes a file an editor can have open.
- For the backend diagnostics commands, call `bindHostDiagnostics` in the
  frontend and export `createHostDiagnosticsBackendModule()` from a backend
  module.
- In the backend, export
  `createDataServerConnectionContainerModule(MyHandler)`, where `MyHandler`
  extends `DataServerConnectionHandler` and names your server's port command.

Give each frontend channel its own `servicePath`. Theia refuses a second
channel on a path already open, silently: the frontend hangs with nothing in
the log. For several participants on one channel, use sessions instead.

For the whole setup, see *Host in Theia* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath     | Use it for                                                    | Runs in         |
| ----------- | ------------------------------------------------------------- | --------------- |
| `.`         | Nothing; import a subpath                                     | browser-neutral |
| `./common`  | The data server's notifications as Theia events, on any side  | browser-neutral |
| `./browser` | The port, the connection binding and the diagnostics proxy    | Theia frontend  |
| `./node`    | The connection handler and the backend modules                | Theia backend   |

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
