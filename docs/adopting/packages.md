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
| [`@hydranium/glsp-client-theia`](../../packages/glsp-client-theia/README.md) | …and you run the GLSP head | The GLSP head's client side in Theia, including the diagram widget. |
| **Tooling** | | |
| [`@hydranium/cli`](../../packages/cli/README.md) | always, as a development dependency | `hydranium-cli`: scaffold a project, inspect a grammar, validate models headlessly, generate the transfer model, and drive a data server. |
| [`@hydranium/conformance`](../../packages/conformance/README.md) | you want to check your server against the protocol | A conformance suite you run against your own server, in any test runner. |
| [`@hydranium/langium`](../../packages/langium/README.md) | you import Langium at all | The one route to Langium, so your install has exactly one copy of it. |

For VS Code or a plain browser page there is no client package; copy the
client code from the order-flow example.

## Entry points

- **The package root** of `@hydranium/protocol`, `@hydranium/langium` and each
  server head runs anywhere, a browser included.
- **`./node`** is server-only and may use Node's APIs.
- **`./testing`** is test support; never import it from production code.
- **`@hydranium/core/lsp`** is the LSP head, and
  **`@hydranium/glsp-server/browser`** starts the GLSP head in a web worker.

A package's `exports` field lists all of its subpaths.
