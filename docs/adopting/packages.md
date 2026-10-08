# Packages

All `@hydranium/*` packages are released together at one version. Mixing
versions across the set is unsupported, because several of them share types by
identity rather than by structure. A package name reads
`<head>-<role>-<platform>`, so each head's server and its Theia client sit
together, and a name with no head spans all of them.

| Package | You need it when | What it is |
| --- | --- | --- |
| **Contracts** | | |
| [`@hydranium/protocol`](../../packages/protocol/README.md) | you write any client | The typed contracts between a client and the heads. It has no Langium dependency, so a form editor, tree view or code generator depends on this and nothing else of ours. |
| **Server heads** | | |
| [`@hydranium/core`](../../packages/core/README.md) | always, server-side | The framework runtime: the shared workspace every head works on, and the LSP head at its `/lsp` subpath. |
| [`@hydranium/data-server`](../../packages/data-server/README.md) | a client other than a text editor reads or writes your model | The data head: typed reads, updates and saves of documents. |
| [`@hydranium/glsp-server`](../../packages/glsp-server/README.md) | you want graphical editing | The GLSP head: diagrams derived from your model, and their edits written back to it. |
| **Client integrations** | | |
| [`@hydranium/client-theia`](../../packages/client-theia/README.md) | your host is Theia | What every head needs in a Theia application: logging, diagnostics and connection handling. |
| [`@hydranium/data-client-theia`](../../packages/data-client-theia/README.md) | …and you run the data head | The data head's client side in Theia. |
| [`@hydranium/glsp-client-theia`](../../packages/glsp-client-theia/README.md) | …and you run the GLSP head | The GLSP head's client side in Theia, including the diagram widget. |
| **Tooling** | | |
| [`@hydranium/cli`](../../packages/cli/README.md) | always, as a development dependency | `hydranium-cli`: scaffold a project, inspect a grammar, validate models headlessly, generate the transfer model, and drive a data server. |
| [`@hydranium/conformance`](../../packages/conformance/README.md) | you want to check your server against the protocol | A conformance suite you run against your own server, in any test runner. |
| [`@hydranium/langium`](../../packages/langium/README.md) | you import Langium at all | The one route to Langium, so exactly one copy of it exists in your install. |

The `.` entry of `@hydranium/protocol`, `@hydranium/langium` and each server
head runs anywhere, a browser included. A `./node` subpath is server-only and may use Node's APIs, and a `./testing` subpath is test
support you never import from production code. A few heads have one more:
`@hydranium/core/lsp` is the LSP head, and `@hydranium/glsp-server/browser`
starts the GLSP head in a web worker. A package's `exports` field lists all of
its subpaths.

The client libraries are Theia-only. VS Code and browser hosts are shown end to
end in order-flow, as example code you copy rather than a package you depend
on; the protocol packages are host-neutral, so a client for another host is
supported.
