# Bookstore

A Hydranium language project scaffolded by `hydranium-cli init`.

## Getting started

```bash
npm install
npm run langium:generate   # generate the AST from the grammar
npm run build              # generate + compile to lib/
npm test                   # typecheck the tests, then run them
```

## Try the framework CLI against it

```bash
# Grammar / AST reflection
npx hydranium-cli reflect --services ./lib/node/services.js

# Grammar-convention lint (CI gate)
npx hydranium-cli lint-grammar --services ./lib/node/services.js

# Validate a workspace of model files (non-zero exit on errors)
npx hydranium-cli validate --services ./lib/node/services.js ../workspace

# Data-head operations. `--server` is a command line the CLI spawns and then
# drives the data protocol over the child's stdin/stdout, so it has to name
# `data-server-main.js` — `main.js` gives stdio to LSP and answers these
# methods with "Unhandled method".
#
# The workspace goes to the ENTRY, not to `--cwd`: `--cwd` re-roots the child,
# so a relative entry path is refused by name (an absolute one is fine).
npx hydranium-cli projects --server "node ./lib/data-server-main.js ../workspace"
npx hydranium-cli query --server "node ./lib/data-server-main.js ../workspace" --uri <file:// URI of ../workspace/nodes.bookstore>
```

## Layout

- `src/grammar/bookstore.langium` — the `Bookstore` grammar (.bookstore)
- `src/language-server/bookstore-module.ts` — `createBookstoreServices` DI wiring
- `src/language-server/bookstore-serializer.ts` — emits `Bookstore` back to text (the framework defaults this to a throw)
- `src/language-server/bookstore-validation.ts` — the `Bookstore` checks: a warning on a repeated name
- `src/node/services.ts` — zero-arg `createServices()` for the headless CLI, the package's `./node` entry
- `src/index.ts` — the package root, loadable in a browser worker: DI factory + generated AST + diagram module
- `src/main.ts` — starts lsp + data + glsp, the `bookstore` bin entry
- `src/data-server-main.ts` — the data head alone on stdio, the
  `bookstore-data-server` bin entry and the `--server` value the CLI needs
- `src/glsp/bookstore/` — the `Bookstore` diagram: state, storage, submission handler, GModel factory, configuration, create-node handler, DI module
- `../protocol/` — the `@hydranium/bookstore-protocol` package: what this server and its clients both import (language ids, port commands, diagram ids, the transfer model), written partly by `npm run generate`
- `test/services.test.ts` — the DI tree composes; grows as your language does
- `test/parsing.test.ts` / `linking.test.ts` / `validating.test.ts` — the three tiers a new language breaks first
- `test/serialization.test.ts` — each grammar round-trips through its serializer
- `syntaxes/` — generated TextMate grammar for a VS Code extension (gitignored)

The two entry points are `bin` scripts rather than `main` on purpose:
each opens a transport at module scope, so importing one would start a
server as a side effect. Compose the language through `src/index.ts` instead.

## Three names, and when they diverge

The scaffold sets all three to the same value, which is right for one
grammar and stops being right the moment you add a second:

| Name | Set by | Generates |
| --- | --- | --- |
| project | `--name` / `projectName` | `BookstoreAstReflection`, `BookstoreGeneratedSharedModule` — one set per project |
| grammar | `--grammar` / `grammar X` | `<Grammar>GeneratedModule`, `<Grammar>LanguageMetaData` — one set per grammar |
| language id | derived, or `--language-id` | file routing, the `langium-config` entry id |

A further grammar is another `--grammar` (or another entry in
`langium-config.json` — never a second config file, because `AstReflection`
is one shared slot) with its own grammar name, while the project name stays
the umbrella.

Each grammar declares its own entry rule (`<Grammar>Model`) rather than a
shared `Model`, because one `langium-cli` run over N grammars emits one
combined `ast.ts` and two `Model` interfaces would collide in it.

The `langium` / `langium-cli` versions are pinned exactly rather than
ranged: the framework treats `langium` and its `vscode-*` chain as one
atomic set and depends on a single physical copy, so a floating range can
silently resolve a second one.

`vscode-languageserver` is pinned to `10.0.1`, and
`vscode-languageserver-protocol` and `vscode-jsonrpc` to the `3.18.1` and
`9.0.0` it pins, so Langium, the LSP connection and the framework share one
copy of each. With two, an error a Langium handler returns, such as a request
for a document the server does not have, reaches the client as a result, and a
framework error your own LSP handler throws loses its code. The Langium 4.4
upgrade
([eclipse-emfcloud/hydranium#142](https://github.com/eclipse-emfcloud/hydranium/issues/142))
replaces these pins.

## If your repo gates license headers

The emitted `.ts` files carry no copyright header — the scaffold cannot know
your license. Run your own header tool over `src/` and `test/` after
scaffolding. The file-purpose comments are `//` runs rather than `/** */`
blocks precisely so that a tool which REPLACES the leading block comment
does not silently delete them.

The two `bin` entries start with a `#!` line, and it has to STAY the first
line: a header tool that prepends unconditionally leaves the shell reading
the license comment as a script, which is what a linked binary then runs.
