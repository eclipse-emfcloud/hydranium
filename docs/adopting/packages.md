# Packages

Install every `@hydranium/*` package at the same exact version; see
[Stability and versioning](status.md#stability-and-versioning). A package name
reads `<head>-<role>-<platform>`, and a name with no head spans all heads.

| Package | You need it when | What it is |
| --- | --- | --- |
| **Contracts** | | |
| [`@hydranium/protocol`](../../packages/protocol/README.md) | you write any client | The typed contracts between a client and the heads. It has no Langium dependency, so a form editor, tree view or code generator depends on this alone. |
| **Server heads** | | |
| [`@hydranium/core`](../../packages/core/README.md) | always, server-side | The framework runtime: the shared workspace every head works on, and the LSP head at its `/lsp` subpath. |
| [`@hydranium/data-server`](../../packages/data-server/README.md) | a client other than a text editor reads or writes your model | The data head: typed reads, updates and saves of documents. |
| [`@hydranium/glsp-server`](../../packages/glsp-server/README.md) | you want graphical editing | The GLSP head: diagrams derived from your model, with their edits written back to it. |
| **Client integrations** | | |
| [`@hydranium/client-theia`](../../packages/client-theia/README.md) | your host is Theia | What every head needs in a Theia application: logging, diagnostics and connection handling. |
| [`@hydranium/data-client-theia`](../../packages/data-client-theia/README.md) | …and you run the data head | The data head's client side in Theia. |
| [`@hydranium/glsp-client`](../../packages/glsp-client/README.md) | you run the GLSP head, whatever the host | The GLSP head's client side for any host: the diagram classes, the binder that mounts them, and the mount for a plain page. |
| [`@hydranium/glsp-client-theia`](../../packages/glsp-client-theia/README.md) | …and your host is Theia | The GLSP head's client side in Theia, including the diagram widget. |
| [`@hydranium/client-browser`](../../packages/client-browser/README.md) | your host is a web page | The page side of a host whose heads run in a web worker: the worker bootstrap, the LSP handshake, a Monaco editor's LSP client and the data head's port. |
| [`@hydranium/client-vscode`](../../packages/client-vscode/README.md) | your host is VS Code and runs a socket head | What every head needs in a VS Code extension: the lookup of a socket head's port, and the commands that publish it to a Theia app. |
| [`@hydranium/data-client-vscode`](../../packages/data-client-vscode/README.md) | …and you run the data head | The data head's client side in VS Code: the extension host's relay and the webview's data port. |
| [`@hydranium/glsp-client-vscode`](../../packages/glsp-client-vscode/README.md) | …and you run the GLSP head | The GLSP head's client side in VS Code, including the diagram's custom editor and its webview starter. |
| **Tooling** | | |
| [`@hydranium/cli`](../../packages/cli/README.md) | always, as a development dependency | `hydranium-cli`: scaffold a project, inspect a grammar, validate models headlessly, generate the transfer model, and drive a data server. |
| [`@hydranium/conformance`](../../packages/conformance/README.md) | you want to check your server against the protocol | A conformance suite you run against your own server, in any test runner. |
| [`@hydranium/langium`](../../packages/langium/README.md) | you import Langium at all | The one route to Langium, so your install has exactly one copy of it. |

## Entry points

- **The package root** of `@hydranium/protocol`, `@hydranium/langium` and each
  server head runs anywhere, a browser included.
- **`./node`** is server-only and may use Node's APIs.
- **`./testing`** is test support; never import it from production code.
- **`@hydranium/core/lsp`** is the LSP head.
- **A server package's `./browser`** is for a web worker:
  **`@hydranium/core/browser`** hosts the heads there, starts the LSP head and
  holds the IndexedDB store a worker keeps its workspace in;
  **`@hydranium/data-server/browser`** and **`@hydranium/glsp-server/browser`**
  start their heads. A Theia client package's `./browser` is its frontend
  tier.

A package's `exports` field lists all of its subpaths.
