# `@hydranium/client-theia`

The Theia pieces every
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) head shares: the
Output-channel logger, the editor's save handling, the diagnostics commands and
the backend's socket bridge. Install it when your language's editors live in a
Theia application, beside `@hydranium/data-client-theia` or
`@hydranium/glsp-client-theia`.

## What it gives you

- Your frontend's log lines in an Output channel you name, aligned with the
  server's own log, and the log level driven by a Theia preference.
- Editors that stay correct when a server saves a file they show unsaved.
- Diagnostics commands for the server's memory, heap and profile, under your
  own command prefix and category.
- Notifications while a head connects, and once when it fails.
- Messages held while the websocket is down, and the outage logged.
- The socket bridge the head packages build their backend handlers on.

## Install

```bash
npm install @hydranium/client-theia
```

| Peer                  | Range         |
| --------------------- | ------------- |
| `@hydranium/protocol` | `^1.0.0-next` |
| `@theia/core`         | `^1.70.0`     |
| `@theia/editor`       | `^1.70.0`     |
| `@theia/filesystem`   | `^1.70.0`     |
| `@theia/output`       | `^1.70.0`     |
| `inversify`           | `^6.0.0`      |
| `vscode-jsonrpc`      | `^9.0.0`      |

`@theia/output` is easy to miss: the logger and the diagnostics commands both
write to an Output channel, so add it if your application does not have it yet.

## Wiring

This package is a library, not a Theia extension: it declares no
`theiaExtensions`. Your own extension declares them and binds from here.

- In a frontend module, call `bindChannelLogger` and `bindLogLevelPreference`.
  Call `bindEditorDiskSync` whenever a server writes files an editor can have
  open.
- For the diagnostics commands, bind `MemoryDiagnosticsService` to your own
  data-server frontend, then call `bindMemoryDiagnostics`.
- For the websocket, call `bindConnectionResilience` in a `frontendPreload`
  module and in a backend module, and `bindConnectionDiagnostics` beside the
  logger. From a normal frontend module the first call comes too late and
  silently does nothing.
- In the backend, you usually subclass a head-specific handler from
  `@hydranium/data-client-theia` or `@hydranium/glsp-client-theia` rather than
  the base here.

For the whole setup, see *Host in Theia* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath     | Use it for                                                 | Runs in         |
| ----------- | ---------------------------------------------------------- | --------------- |
| `.`         | Nothing; import a subpath                                  | browser-neutral |
| `./browser` | The frontend bind helpers and the classes they bind        | Theia frontend  |
| `./common`  | The pieces both sides share, such as the clock token       | browser-neutral |
| `./node`    | The backend socket bridge and the websocket hardening      | Theia backend   |
| `./testing` | Test doubles for the Output channel and Inversify contexts | browser-neutral |

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
