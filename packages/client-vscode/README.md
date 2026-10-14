# `@hydranium/client-vscode`

The cross-head VS Code side of a
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) host. Install it
when a VS Code extension starts your language server and a socket head (data
or GLSP) runs beside it: it finds each head's port from the extension host,
and publishes the ports to a Theia app that sideloads the extension.

## What it gives you

- A head's port, asked from the running language client and polled until the
  server answers, bounded so a request the server never publishes fails
  instead of waiting forever.
- One host command per head that answers its port, which is how a Theia app's
  backend reaches the heads of a server the extension started.

## Install

```bash
npm install @hydranium/client-vscode
```

No peer dependencies; the extension host provides `vscode`.

## Wiring

After the language client has started, register the port commands a Theia
host polls, and ask for a port where a head's client connects. Ask once per
connection rather than caching the answer: a restarted server binds a fresh
port.

<!-- snippet-preamble
import type { ExtensionContext } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node.js';
declare const context: ExtensionContext;
declare const client: LanguageClient;
-->

```ts
import { findPort, registerPortCommands } from '@hydranium/client-vscode/node';

registerPortCommands(context, client, {
   'my-language.port.dataServer': 'my-language/data-server/port',
   'my-language.port.glsp': 'my-language/glsp-server/port'
});
const glspPort = await findPort(client, 'my-language/glsp-server/port');
```

`@hydranium/data-client-vscode` and `@hydranium/glsp-client-vscode` take the
lookup as their `findPort` option. For the whole setup, see *Host in VS
Code* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath  | Use it for                            | Runs in                    |
| -------- | ------------------------------------- | -------------------------- |
| `.`      | Nothing yet                           | anywhere                   |
| `./node` | The port lookup and the port commands | the VS Code extension host |

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
