# bookstore — the day-one example

What `hydranium-cli init` scaffolds, checked in and built by CI. One grammar,
three heads, a graphical editor, and no adopter overrides at all.

```
server/      the scaffold, verbatim but for its package name (see the table
             below), plus the generated tree its own `build` writes
workspace/   two `.bookstore` files it is exercised against
```

It was created by exactly this, and nothing else:

```bash
npx hydranium-cli init examples/bookstore/server \
   --name Bookstore --heads lsp,data,glsp --grammar Bookstore --diagram \
   --monorepo
```

> **Deliberately minimal.** Nothing belongs here that `init` does not already
> emit, and the reason is stronger than tidiness — see
> [Regenerability](#regenerability-is-the-constraint-not-an-aspiration) before
> proposing an addition. Anything worth demonstrating that the scaffold does not
> emit belongs in [`order-flow`](../order-flow/README.md).

## Running it

```bash
npm --prefix examples/bookstore/server run build
npm --prefix examples/bookstore/server test

npx hydranium-cli reflect      --services examples/bookstore/server/lib/services.js
npx hydranium-cli lint-grammar --services examples/bookstore/server/lib/services.js
npx hydranium-cli validate     --services examples/bookstore/server/lib/services.js \
   examples/bookstore/workspace

# The four data-head subcommands, against the emitted stdio entry
npx hydranium-cli projects --server \
   "node ./examples/bookstore/server/lib/data-server-main.js ./examples/bookstore/workspace"
```

The `--server` entry is `src/data-server-main.ts`, which `init` emits with the
`data` head — the workspace goes to the entry rather than to `--cwd`, because
`--cwd` re-roots the child and would leave the relative entry path resolving
against the workspace. `main.ts` will not do: stdio there carries LSP, and the
data head is a socket whose port is published over the LSP connection, which a
`--server` client has no way to ask for.

There is no host application.

## What a new adopter gets on day one

Every other example in this repo overrides something by hand. This one overrides
nothing the scaffold did not write for it — the one bound slot below is `init`'s,
not an adopter's — which is the claim a new adopter has to trust before they have
written any code:

| Seam | bookstore | what answers instead |
| --- | --- | --- |
| Hover | no `HoverProvider` | Langium's default, over the fixture's `/** … */` comments |
| Semantic tokens | no provider | the client's own TextMate grammar |
| Validation | no checks | parser + linker diagnostics |
| Integrity | no rules | the framework's build pipeline |
| Scoping | no `project` header | the `universal` export tier |
| Serialization | the emitted `BookstoreSerializer` | the one slot `init` binds, the framework's default being a throw — see below |

## The diagram is editable, and what that costs

`--diagram` emits a starter `CreateNodeOperation` handler
(`server/src/glsp/bookstore/create-node-operation-handler.ts`), so a node
created on the canvas appends a `node <name>` line to the `.bookstore` document.
Deleting that file and its registration gives back a read-only viewer; no type
hint changes either way, because creation is offered through the tool palette
rather than through a hint.

The handler composes text rather than round-tripping the AST, which is the
smaller thing to read and does not depend on which serializer you kept. The
full-text source model does round-trip: it serialises through the per-URI
`Serializer`, which `init` emits as
`server/src/language-server/bookstore-serializer.ts`, so `state.sourceModel` and
a `SaveModelAction` reach a real emitter rather than the framework's throwing
default. Either way a diagram edit reaches the file the way a real host works:
the change lands in the text document, the language client receives it as a
`workspace/applyEdit`, and the editor saves it.

## Why it is also a provenance target

`scripts/check-init-provenance.mjs` re-derives the scaffold from the invocation
above and compares it file by file. `order-flow` is recorded at the DEFAULT head
set — its diagram runs the reconciling multi-document strategy, a different set
of classes from the one `--diagram` emits — so before this example the whole
GLSP template path was pinned by a golden file and executed by nothing.

**That coverage gets WEAKER the more is added to it**, which is the same reason
the file table below is nearly all `identical`.

## Why it is nested, when a single-package example need not be

`examples/` holds one directory per example, each holding one package per host,
and the repository guide allows a single-package example to sit directly at
`examples/<name>`. This one still gets its own directory because it is not
single-directory: it owns a `workspace/` fixture beside its `server/` package,
and an example owns the directory its parts live in. Flattening would put
`bookstore-workspace` next to `order-flow`, which reads as a second example.

## Regenerability is the constraint, not an aspiration

Bookstore must stay reproducible from **one `init` invocation plus its grammar**.
The previous small example in this repo began the same way and accreted seams
until it was a second gate nobody wanted to maintain; a hand-written addition
here is both a step down that road and a direct loss of the provenance claim
above, because a target that has been adapted pins nothing.

One adaptation exists, and it is one field, recorded in the manifest with its
reason:

| File | Verdict | Why |
| --- | --- | --- |
| `server/package.json` | adapted | the in-repo `@hydranium/example-*` package name, and only that field — it encodes a convention, not a fact about the tree, so no detection can supply it. The manifest names the exemption, so every other field is held against the emission; key order is the repository formatter's rather than the template's |
| everything else | identical | including `vitest.config.ts`, deliberately NOT switched to the repo's shared helper: this is the only target pinning the scaffold's own self-contained config |

The `lint` script and the 140-column wrapping used to be adaptations too. `init`
now reads the workspace root's eslint config and prettier `printWidth`, so both
are emitted — which is what a provenance target is for: the manifest shrinking
is the gate reporting a template gain rather than drift.

A second host, a form-editor frontend and anything perf-shaped are all out of
scope here on the same grounds: if `init` does not emit it, the gap it closes is
not bookstore's. A serializer was on that list until `init` learnt to emit one,
which is the rule working in the direction it is supposed to — the way to give
bookstore a seam is to teach the scaffold it.

The example README under `server/` is the scaffold's own, unedited, which is why
this file exists rather than that one carrying the prose.
