# `@hydranium/client-browser`

The page side of a [Hydranium](https://github.com/eclipse-emfcloud/hydranium)
host that runs its heads in a web worker, with no backend. Install it when
your language runs in a plain web page: it hands each head its own
`MessagePort`, runs the page's LSP handshake, makes a Monaco editor the LSP
head's client, and gives the data head its port.

## What it gives you

- One `MessagePort` per head, transferred to the worker in the framework's
  bootstrap message, so no head is ever bound to the worker's global scope.
- The LSP head's connection with the server's own requests answered: the
  capability registrations and the configuration section it reads while the
  workspace comes up.
- A Monaco editor as the LSP head's client, from `./monaco`: the languages and
  providers registered, `workspace/applyEdit` answered, `didOpen`, `didChange`
  and `didClose` sent for the documents you open, and a save of the unsaved
  ones through the data head.
- A `DataPort` over the data head's port, for the connection and sessions from
  `@hydranium/protocol`.
- The GLSP head's connection, for GLSP's own client.
- Pending requests rejected when the worker fails to start or fails its
  bootstrap, instead of waiting forever, since a port cannot report a dead
  peer.

## Install

```bash
npm install @hydranium/client-browser
```

| Peer                             | Range             |
| -------------------------------- | ----------------- |
| `@hydranium/protocol`            | `^1.0.0-next`     |
| `monaco-editor-core`             | `>=0.56.0 <1.0.0` |
| `vscode-jsonrpc`                 | `^9.0.0`          |
| `vscode-languageserver-protocol` | `~3.18.1`         |

`monaco-editor-core` is optional; only `./monaco` needs it.

## Wiring

Build the `Worker` yourself, from a URL your build gives you, and hand it to
`connectWorkerHeads`. Run the LSP handshake on the LSP head's connection before
anything else uses it, and give the data head's port to a data connection:

<!-- snippet-preamble
import { connectWorkerHeads } from '@hydranium/client-browser';
// The page's `Worker`, which has no name under this gate's DOM-free lib.
declare const worker: Parameters<typeof connectWorkerHeads>[0];
-->

```ts
import { initializeLanguageClient } from '@hydranium/client-browser';
import { DataConnectionWithEvents } from '@hydranium/protocol';

const heads = connectWorkerHeads(worker);
heads.onWorkerError(report => console.error(`worker, ${report.phase}: ${report.message}`));
const { capabilities } = await initializeLanguageClient(heads.lsp, {
   rootUri: 'file:///workspace',
   configuration: { section: 'my-language', settings: () => ({ log: { level: 'info' } }) }
});
const data = new DataConnectionWithEvents(heads.data);
```

In the worker, answer the bootstrap with `hostHeadsInWorker` from
`@hydranium/core/browser`, which starts each head on its port, never on the
worker's global scope, posts the ready message once they are up and reports
a failed start, build or rejection. A worker of your own reads the bootstrap
with `isWorkerBootstrapMessage` from `@hydranium/protocol`, posts a
`WorkerReadyMessage` once its heads are up and a `WorkerErrorMessage` for a
failure it catches; one under `WORKER_BOOTSTRAP_PHASE` ends the page's heads,
any other phase only reports. Until the worker has posted its ready message,
or anything on a head's port, the `Worker`'s `error` event ends the heads too.

Register the handler for the server's diagnostics in `beforeInitialized`,
which runs once `initialize` has answered and before `initialized` goes out.
A second handler for the same notification replaces the first, so fan out
from one.

The data port reports a data-head failure to the console. A host with a
surface of its own subclasses `WorkerDataPort` and passes it as
`createDataPort`.

Build the Monaco client, from `./monaco`, in `beforeInitialized` too, from the
server's capabilities and your language table, and hand it each diagnostics
notification. Open a document on the text the worker holds, never on a copy
in your bundle, and create editors through the client, which keeps the
settings a server-driven language needs under your own. Save through the
client: the server already holds every edit, so `save` and `saveAll` ask the
worker's LSP head to persist them. `saveDirtyDocuments` saves through a data
session instead, for a server whose LSP head does not advertise the request.

<!-- snippet-preamble
import { connectWorkerHeads } from '@hydranium/client-browser';
declare const worker: Parameters<typeof connectWorkerHeads>[0];
declare const container: HTMLElement;
declare const textFromTheWorker: string;
const heads = connectWorkerHeads(worker);
-->

```ts
import { initializeLanguageClient } from '@hydranium/client-browser';
import { MONACO_CLIENT_CAPABILITIES, MonacoLspClient } from '@hydranium/client-browser/monaco';
import { PublishDiagnosticsNotification } from 'vscode-languageserver-protocol';

let client!: MonacoLspClient;
await initializeLanguageClient(heads.lsp, {
   rootUri: 'file:///workspace',
   capabilities: MONACO_CLIENT_CAPABILITIES,
   beforeInitialized: result => {
      client = new MonacoLspClient(heads.lsp, result.capabilities, {
         languages: [{ id: 'my-language', extensions: ['.my'] }]
      });
      heads.lsp.onNotification(PublishDiagnosticsNotification.type, params => client.applyDiagnostics(params));
   }
});
const model = client.openDocument('file:///workspace/a.my', textFromTheWorker);
client.createEditor(container, model, { theme: 'vs' });
await client.saveAll();
```

`MONACO_CLIENT_CAPABILITIES` declares `workspace.applyEdit`, which the Monaco
client answers, and every form it renders, so a server that gates a form on
its capability sends it. A host with another editor declares its own, and
registers its own `workspace/applyEdit` handler before it opens a document,
as any LSP client does, or the server's writes to that document are lost.

For the whole setup, see *Host in a browser* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath    | Use it for                                                | Runs in    |
| ---------- | --------------------------------------------------------- | ---------- |
| `.`        | The worker bootstrap, the LSP handshake and the data port | a web page |
| `./monaco` | The Monaco editor as the LSP head's client, and its save  | a web page |

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
