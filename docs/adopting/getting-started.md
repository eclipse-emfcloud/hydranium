# Getting started

From nothing to a language server you have built, tested and run a model
through, with the CLI's `init` doing the wiring.

## Before you start

Node and npm must be at least the versions [Requirements](requirements.md)
names.

> **Pin an exact version.** Every release is a prerelease, and a caret range
> matches no prerelease, so a range will not resolve one. `init` writes exact
> versions for you.

## Scaffold a language

```bash
npx @hydranium/cli init ./my-lang --name MyLang --heads lsp,data,glsp
```

`init` writes a complete project: a starter grammar in `src/grammar/`, the
services wiring, a server entry that starts every head, and build and test
scripts. The three
heads serve text editors (LSP), forms and tools (data) and a diagram (GLSP);
leave `glsp` out for a language without one. Leave `--name` off on a terminal
and `init` asks instead, then prints the command it composed. Every option is
in the [CLI README](../../packages/cli/README.md).

## Build and test

```bash
cd my-lang
npm install
npm run build    # generate the AST and the transfer model, compile into lib/
npm test         # a test that composes your services
```

The project's own README describes each file `init` wrote.

## Validate a model

The starter grammar declares nodes, each of which may point at another. Write
one into a model directory, `models/first.my-lang`:

```text
node Start -> End
node End
```

```bash
npx hydranium-cli validate --services ./lib/services.js ./models
```

It reports no problems. Change `End` in the first line to `Missing` and run it
again: it reports the unresolved reference with its position and exits
non-zero, so it works as a check in CI.

## Look at the language with the CLI

```bash
npx hydranium-cli reflect --services ./lib/services.js        # types, terminals, cross-references
npx hydranium-cli lint-grammar --services ./lib/services.js   # grammar conventions, as a CI check
npx hydranium-cli model-docs --services ./lib/services.js --out-file model-reference.md
```

Edit the grammar, rebuild, and run them again: each reads the built services,
so it always describes the language as it is.

## Where to go from here

- **Understand what you built.** [Architecture](../concepts/architecture.md)
  explains the heads and the one shared workspace behind them.
  [bookstore](../../examples/bookstore/README.md) is what `init` gives you, with
  a sample workspace; read it beside your own project.
- **Build a complete application.** [order-flow](../../examples/order-flow/README.md)
  is the application behind the
  [live demo](https://eclipse-emfcloud.github.io/hydranium/): three grammars
  that reference each other, all three heads, and Theia, VS Code and browser
  hosts. The [guides](../ADOPTING.md#guides) walk through the common tasks, and
  [Framework vs. adopter](../concepts/framework-vs-adopter.md) shows the seams a
  real language customizes.

To wire Hydranium into an existing project instead of a scaffold, see
[Compose a server by hand](../guides/compose-a-server.md).
