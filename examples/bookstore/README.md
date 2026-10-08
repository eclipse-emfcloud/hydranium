# bookstore

Exactly what `hydranium-cli init` scaffolds, checked in and built by CI: one
grammar, three heads, a graphical editor, no host application, and no adopter
overrides. Read it beside your own scaffold.

```
server/      the scaffold, verbatim but for its package name, plus the
             generated tree its own `build` writes
workspace/   two `.bookstore` files it is exercised against
```

It was created by exactly this, and nothing else:

```bash
npx hydranium-cli init examples/bookstore/server \
   --name Bookstore --heads lsp,data,glsp --grammar Bookstore --diagram \
   --monorepo
```

## Running it

```bash
npm --prefix examples/bookstore/server run build
npm --prefix examples/bookstore/server test

npx hydranium-cli reflect      --services examples/bookstore/server/lib/services.js
npx hydranium-cli lint-grammar --services examples/bookstore/server/lib/services.js
npx hydranium-cli validate     --services examples/bookstore/server/lib/services.js \
   examples/bookstore/workspace

# A data-head subcommand, against the emitted stdio entry
npx hydranium-cli projects --server \
   "node ./examples/bookstore/server/lib/data-server-main.js ./examples/bookstore/workspace"
```

`--server` spawns `src/data-server-main.ts`, the stdio data entry `init` emits
with the `data` head; pass the workspace to it rather than through `--cwd`,
which re-roots the child and breaks the relative entry path. `main.ts` will
not do: its stdio carries LSP, and its data head is a socket whose port is
published over the LSP connection.

## What a new adopter gets on day one

This example overrides nothing the scaffold did not write for it. The one bound
slot below is `init`'s, not an adopter's.

| Seam | bookstore | what answers instead |
| --- | --- | --- |
| Hover | no `HoverProvider` | Langium's default, over the fixture's `/** … */` comments |
| Semantic tokens | no provider | the client's own TextMate grammar |
| Validation | no checks | parser + linker diagnostics |
| Integrity | no rules | the framework's build pipeline |
| Scoping | no `project` header | the `universal` export tier |
| Serialization | the emitted `BookstoreSerializer` | the one slot `init` binds, the framework's default being a throw |

## The editable diagram

`--diagram` emits a starter create handler,
[create-node-operation-handler.ts](server/src/glsp/bookstore/create-node-operation-handler.ts).
Creating a node on the canvas appends a `node <name>` line to the `.bookstore`
document, written once through the emitted
[bookstore-serializer.ts](server/src/language-server/bookstore-serializer.ts),
and undo and redo apply that one change. Delete the handler and its
registration in `diagram-module.ts` for a read-only viewer.
[bookstore-diagram.test.ts](server/test/bookstore-diagram.test.ts) runs the
handler through an in-process GLSP server and checks that the create, the undo
and the redo keep the existing nodes.

## Changing this example

Bookstore must stay reproducible from one `init` invocation plus its grammar.
`scripts/check-init-provenance.mts` re-derives the scaffold from the invocation
above and compares it file by file, so every file must stay identical to what
`init` emits except one field:

| File | Verdict | Why |
| --- | --- | --- |
| `server/package.json` | adapted | the in-repo `@hydranium/example-*` package name, and only that field |
| everything else | identical | including `vitest.config.ts`, which keeps the scaffold's own config rather than the repo's shared helper |

Anything `init` does not emit belongs in [order-flow](../order-flow/README.md),
or teach `init` to emit it. `server/README.md` is the scaffold's own README,
so example prose goes in this file.
