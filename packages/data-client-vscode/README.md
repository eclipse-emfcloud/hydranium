# `@hydranium/data-client-vscode`

The data head's client side in a VS Code extension built on
[Hydranium](https://github.com/eclipse-emfcloud/hydranium). Install it when a
webview of your extension reads or writes models through the data head: a
webview has no sockets, so the extension host relays the data-server's socket
to it over a `vscode-messenger` hop, and the webview's data port reads it.

## What it gives you

- The extension host's relay from the data-server's socket to one webview,
  with the port looked up again for every connection, so a restarted server
  is found.
- A channel over the messenger for each end of the hop, filtered to the one
  webview it serves, so the hop can be shared with GLSP's diagram webviews.
- The webview's `DataPort`, for the connection and sessions from
  `@hydranium/protocol`, which rejects pending requests when the extension host
  reports the relay lost.
- A `DataPort` over a socket for code in the extension host itself, such as a
  command, which looks the port up again for every connection.

## Install

```bash
npm install @hydranium/data-client-vscode
```

| Peer                       | Range         |
| -------------------------- | ------------- |
| `@hydranium/protocol`      | `^1.0.0-next` |
| `vscode-jsonrpc`           | `^9.0.0`      |
| `vscode-messenger`         | `^0.4.5`      |
| `vscode-messenger-common`  | `^0.4.5`      |
| `vscode-messenger-webview` | `^0.4.5`      |

The `vscode-messenger` packages are optional; only `./testing` loads them.
Your extension and webview use the copies GLSP's VS Code integration brings,
or their own.

## Wiring

In the extension host, connect each webview to the data head over a messenger
constructed with `ignoreHiddenViews: false`, as `GlspVscodeConnector`'s is, or
a hidden webview misses every answer. Tell the webview when the relay closes,
since nothing else reaches it:

<!-- snippet-preamble
import type { MessageParticipant } from 'vscode-messenger-common';
import type { Messenger } from 'vscode-messenger';
declare const messenger: Messenger;
declare const webview: MessageParticipant;
declare function findDataServerPort(): Promise<number>;
declare function tellWebviewConnectionLost(): void;
-->

```ts
import { connectDataServer } from '@hydranium/data-client-vscode/node';

const relay = connectDataServer({ messenger, webview, findPort: findDataServerPort });
relay.onClose(() => tellWebviewConnectionLost());
```

In the webview, build the port over the mirror channel, start the messenger,
and hand the port to a data connection; call `connectionLost` on the port
when the extension host says the relay closed:

```ts
import { createWebviewSideChannel } from '@hydranium/data-client-vscode';
import { WebviewDataPort } from '@hydranium/data-client-vscode/browser';
import { DataConnectionWithEvents } from '@hydranium/protocol';
import { HOST_EXTENSION } from 'vscode-messenger-common';
import { Messenger, type VsCodeApi } from 'vscode-messenger-webview';

// VS Code injects it into the webview; there is nothing to import.
declare function acquireVsCodeApi(): VsCodeApi;

const messenger = new Messenger(acquireVsCodeApi());
const port = new WebviewDataPort(createWebviewSideChannel(messenger, HOST_EXTENSION));
messenger.start();
const connection = new DataConnectionWithEvents(port);
```

For code in the extension host itself, give the connection a `SocketDataPort`
instead, which opens the socket there; nothing connects until the first
request:

<!-- snippet-preamble
declare function findDataServerPort(): Promise<number>;
-->

```ts
import { SocketDataPort } from '@hydranium/data-client-vscode/node';
import { DataConnectionWithEvents } from '@hydranium/protocol';

const port = new SocketDataPort({ findPort: findDataServerPort });
const connection = new DataConnectionWithEvents(port);
```

To test a webview's data path in Node, `makeMessengerHarness` from `./testing`
joins the real extension-side and webview-side messengers through a fake
panel and a fake `window`, so the test runs their real routing.

For the whole setup, see *Host in VS Code* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath     | Use it for                                    | Runs in                    |
| ----------- | --------------------------------------------- | -------------------------- |
| `.`         | The messenger channel both ends build on      | anywhere                   |
| `./node`    | The relay, and the extension host's own port  | the VS Code extension host |
| `./browser` | The webview's data port                       | a webview                  |
| `./testing` | The real messenger pair joined in a Node test | a test                     |

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
