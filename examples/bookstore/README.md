# bookstore

Exactly what `hydranium-cli init` scaffolds, checked in and built by CI: one
grammar, three heads, a graphical editor, a browser page, a VS Code extension,
and no adopter overrides. Read it beside your own scaffold.

```
protocol/       what the server and its clients both import: ids, port
                commands, diagram ids and the generated transfer model
server/         the grammar, the language and its heads, plus the generated
                tree its own `build` writes
client/         the diagram's client side, which every host mounts
host-browser/   a page running every head in a web worker, and its smoke test
vscode-servers/ a VS Code extension that starts the server, with no editor
host-vscode/    the VS Code extension: the language client, the diagram
                editor, and its smoke test
workspace/      the two starter `.bookstore` files it is exercised against
```

Each package's README is the scaffold's own:
[server](server/README.md), [protocol](protocol/README.md),
[client](client/README.md), [host-browser](host-browser/README.md),
[vscode-servers](vscode-servers/README.md) and
[host-vscode](host-vscode/README.md).

It was created by exactly this; the few files it holds that `init` does not
write are named under "Changing this example":

```bash
npx hydranium-cli init examples/bookstore \
   --name Bookstore --heads lsp,data,glsp --grammar Bookstore --diagram \
   --hosts browser,vscode --scope @hydranium --monorepo
```

## Running it

```bash
npm --prefix examples/bookstore/server run build
npm --prefix examples/bookstore/server test

npx hydranium-cli reflect      --services examples/bookstore/server/lib/node/services.js
npx hydranium-cli lint-grammar --services examples/bookstore/server/lib/node/services.js
npx hydranium-cli validate     --services examples/bookstore/server/lib/node/services.js \
   examples/bookstore/workspace

# A data-head subcommand, against the emitted stdio entry
npx hydranium-cli projects --server \
   "node ./examples/bookstore/server/lib/data-server-main.js ./examples/bookstore/workspace"
```

In a browser, after `npm run build:all`:

```bash
npm --prefix examples/bookstore/host-browser start      # open the URL it prints
npm --prefix examples/bookstore/host-browser run test:e2e
```

CI runs that smoke test in its Chromium job. It loads the page, checks what
each head shows, and saves an edit that has to survive a reload.

In VS Code, after `npm run build:all`:

```bash
npm --prefix examples/bookstore/host-vscode start      # needs `code` on the PATH
npm --prefix examples/bookstore/host-vscode run test:e2e:install
npm --prefix examples/bookstore/host-vscode run test:e2e
```

CI runs that smoke test in its VS Code job, under `xvfb-run`. It opens the
diagram of `nodes.bookstore` and checks that the server reports a broken
reference.

The server's `build` runs `generate` first, which writes the protocol
package's `src/generated-hydranium/` from the grammar, then compiles both.
`validate` exits zero: nothing in the workspace is deliberately broken.

`--server` spawns `src/data-server-main.ts`, the stdio data entry `init` emits
with the `data` head; pass the workspace to it rather than through `--cwd`,
which re-roots the child and breaks the relative entry path. `main.ts` will
not do: its stdio carries LSP, and its data head is a socket whose port is
published over the LSP connection.

## What a new adopter gets on day one

This example overrides nothing the scaffold did not write for it. The two bound
slots below are `init`'s, not an adopter's.

| Seam | bookstore | what answers instead |
| --- | --- | --- |
| Hover | no `HoverProvider` | Langium's default, over the workspace's `/** … */` comments |
| Semantic tokens | no provider | the client's own TextMate grammar |
| Validation | the emitted `BookstoreValidationContribution` | a warning on a repeated name, beside parser + linker diagnostics |
| Integrity | no rules | the framework's build pipeline |
| Scoping | no `project` header | the `universal` export tier |
| Serialization | the emitted `BookstoreSerializer` | bound by `init`, the framework's default being a throw |

The workspace shows the hover and scoping rows at work:

- **A cross-document reference.** `references.bookstore` points at a node
  declared in `nodes.bookstore`. The grammar declares no `project` header, so
  every name is exported at the `universal` tier and the reference resolves
  without a scope contribution, a project descriptor or a `requires` edge.
- **Hover with no hover provider.** Each node carries a `/** … */` comment,
  and Langium's default hover renders it, on the declaration and on a
  reference in either file. Keep the second asterisk: the hover reads
  comments through `JSDocDocumentationProvider`, which accepts only a `/**`
  opener, so a plain `/* … */` comment yields no hover.

## The editable diagram

`--diagram` emits a starter create handler,
[create-node-operation-handler.ts](server/src/glsp/bookstore/create-node-operation-handler.ts),
and a delete handler,
[delete-operation-handler.ts](server/src/glsp/bookstore/delete-operation-handler.ts).
Creating a node on the canvas appends a `node <name>` line to the `.bookstore`
document, written once through the emitted
[bookstore-serializer.ts](server/src/language-server/bookstore-serializer.ts),
and undo and redo apply that one change. Deleting a node also clears the
references to it in the same document. For a read-only viewer, delete both
handlers and their registrations in `diagram-module.ts`, and set `deletable`
back to `false` in `diagram-configuration.ts`.

The diagram draws the nodes of the document the editor shows, each a row above
the node it references, and a reference into another document as an edge to a
dashed external node standing for its target: `references.bookstore` shows
`Third` pointing at `Second (nodes.bookstore)`. Diagnostics show on the nodes
as markers.
[bookstore-diagram.test.ts](server/test/bookstore-diagram.test.ts) runs the
handlers through an in-process GLSP server: the create, the undo and the redo
keep the existing nodes, a delete takes the references to a node with it, a
reference into another document draws its edge to one external node, the
placing survives a cycle, and a diagnostic becomes a marker.

## Changing this example

Bookstore must stay reproducible from one `init` invocation plus its grammar.
`scripts/check-init-provenance.mts` re-derives the scaffold from the invocation
above and compares it file by file, so every file it emits must stay identical
to what `init` writes, the package names included: `--scope @hydranium` makes
them the scaffold's own. That includes `server/vitest.config.ts`, which keeps
the scaffold's own config rather than the repo's shared helper.

The files `init` does not emit are the generated trees each `build` writes and
the `turbo.json` files. The server's and the protocol's order the protocol
package's build after the server's `generate` in this repo's task runner; the
browser host's adds `../workspace`, which its bundle reads, to its build
inputs, and the VS Code host's adds the projects its build type-checks.

Anything else `init` does not emit belongs in
[order-flow](../order-flow/README.md), or teach `init` to emit it. The package
READMEs are the scaffold's own, so example prose goes in this file.
