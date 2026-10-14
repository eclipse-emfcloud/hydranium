# `@hydranium/example-order-flow-protocol`

What the order-flow server and its clients both name. The server, the
host-agnostic [`../client`](../client/README.md) and every shell import it,
so no front end depends on the server to reach a constant. Only the VS Code
extension manifests, which cannot import, still spell the ids out.

## Where to look

| Concern                                  | Files                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| language ids and file extensions         | [`src/generated-hydranium/languages.ts`](src/generated-hydranium/languages.ts)           |
| the socket heads' port commands          | [`src/head-ports.ts`](src/head-ports.ts)                                                 |
| the `.process` diagram and element types | [`src/process-diagram-types.ts`](src/process-diagram-types.ts)                           |
| the transfer model                       | [`src/generated-hydranium/transfer-model.ts`](src/generated-hydranium/transfer-model.ts) |

## What is specific to this package

- **No Langium.** A client installs nothing of the server's to reach these
  values; the element types take their prefixes from `@eclipse-glsp/protocol`
  rather than the GLSP server.
- **`generated-hydranium/` is written by the server.** The server's
  `generate:transfer-model` writes both files there from its grammars, and
  they are committed so this package builds without the server. CI fails a
  build that changes the tree, so a grammar change lands with its regenerated
  files.
- **CommonJS.** The ESM server and the CommonJS shells both import it.

## Building

```bash
npm --prefix examples/order-flow/protocol run build
npm --prefix examples/order-flow/server run build   # after a grammar change
```

Under turbo this package's build waits on the server's `generate`, so a
package that reads only this one still compiles against the current grammar.
The server's own build regenerates too and rebuilds this package through its
project reference, so building the server alone after a grammar change is
enough.
