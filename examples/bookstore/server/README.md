# Bookstore

A Hydranium language project scaffolded by `hydranium-cli init`.

## Getting started

> **Pre-publish note.** `@hydranium/*` is not on npm yet, so the `0.0.0`
> pins below are placeholders and `npm install` will fail with a 404 until
> the framework is released. Until then, supply the packages from a local
> framework checkout with [yalc](https://github.com/wclr/yalc) — a plain
> `file:` path or `npm link` is not enough, because the framework packages
> depend on each other by version and npm would try to fetch those from the
> registry too.

```bash
npm install
npm run langium:generate   # generate the AST from the grammar
npm run build              # generate + compile to lib/
npm test                   # typecheck the tests, then run them
```

## Try the framework CLI against it

```bash
# Grammar / AST reflection
npx hydranium-cli reflect --services ./lib/services.js

# Grammar-convention lint (CI gate)
npx hydranium-cli lint-grammar --services ./lib/services.js

# Validate a workspace of model files (non-zero exit on errors)
npx hydranium-cli validate --services ./lib/services.js <workspace-dir>

# Data-head operations. `--server` is a command line the CLI spawns and then
# drives the data protocol over the child's stdin/stdout, so it has to name
# `data-server-main.js` — `main.js` gives stdio to LSP and answers these
# methods with "Unhandled method".
#
# The workspace goes to the ENTRY, not to `--cwd`: `--cwd` re-roots the child,
# so a relative entry path is refused by name (an absolute one is fine).
npx hydranium-cli projects --server "node ./lib/data-server-main.js <workspace-dir>"
npx hydranium-cli query --server "node ./lib/data-server-main.js <workspace-dir>" --uri <file:// URI of a .bookstore file>
```

## Layout

- `src/grammar/bookstore.langium` — the `Bookstore` grammar (.bookstore)
- `src/language-server/bookstore-module.ts` — `createBookstoreServices` DI wiring
- `src/language-server/bookstore-serializer.ts` — emits `Bookstore` back to text (the framework defaults this to a throw)
- `src/services.ts` — zero-arg `createServices()` for the headless CLI
- `src/index.ts` — the package entry (`main`): DI factory + generated AST
- `src/main.ts` — starts lsp + data + glsp, the `bookstore` bin entry
- `src/data-server-main.ts` — the data head alone on stdio, the
  `bookstore-data-server` bin entry and the `--server` value the CLI needs
- `src/glsp/bookstore/` — the `Bookstore` diagram: type ids, state, storage, submission handler, GModel factory, configuration, create-node handler, DI module
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

## If your repo gates license headers

The emitted `.ts` files carry no copyright header — the scaffold cannot know
your license. Run your own header tool over `src/` and `test/` after
scaffolding. The file-purpose comments are `//` runs rather than `/** */`
blocks precisely so that a tool which REPLACES the leading block comment
does not silently delete them.

The two `bin` entries start with a `#!` line, and it has to STAY the first
line: a header tool that prepends unconditionally leaves the shell reading
the license comment as a script, which is what a linked binary then runs.
