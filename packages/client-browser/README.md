# `@hydranium/client-browser`

The page side of a [Hydranium](https://github.com/eclipse-emfcloud/hydranium)
host that runs its heads in a web worker, with no backend. Install it when
your language runs in a plain web page: it hands each head its own
`MessagePort`, runs the page's LSP handshake, and gives the data head its port.

## What it gives you

- One `MessagePort` per head, transferred to the worker in the framework's
  bootstrap message, so no head is ever bound to the worker's global scope.
- The LSP head's connection with the server's own requests answered: the
  capability registrations and the configuration section it reads while the
  workspace comes up.
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

| Peer                             | Range         |
| -------------------------------- | ------------- |
| `@hydranium/protocol`            | `^1.0.0-next` |
| `vscode-jsonrpc`                 | `^9.0.0`      |
| `vscode-languageserver-protocol` | `~3.18.1`     |

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

In the worker, read the bootstrap with `isWorkerBootstrapMessage` from
`@hydranium/protocol` and start each head on its port, never on the worker's
global scope. Post a `WorkerErrorMessage` for a failure you catch there; one
under `WORKER_BOOTSTRAP_PHASE` ends the page's heads, any other phase only
reports.

Register the handler for the server's diagnostics in `beforeInitialized`,
which runs once `initialize` has answered and before `initialized` goes out.
A second handler for the same notification replaces the first, so fan out
from one.

The data port reports a data-head failure to the console. A host with a
surface of its own subclasses `WorkerDataPort` and passes it as
`createDataPort`.

The default capabilities declare `workspace.applyEdit`, which the handshake
does not answer: register a `workspace/applyEdit` handler on the connection
before you open a document, as any LSP client does, or the server's writes
to that document are lost.

For the whole setup, see *Host in a browser* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath | Use it for                                                | Runs in    |
| ------- | --------------------------------------------------------- | ---------- |
| `.`     | The worker bootstrap, the LSP handshake and the data port | a web page |

The package needs a TypeScript `moduleResolution` that reads `exports`
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
