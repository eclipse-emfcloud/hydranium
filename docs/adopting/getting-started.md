# Getting started

This page takes you from nothing to a language server you have built, tested
and run a model through. The CLI's `init` does the wiring.

## Before you start

You need Node and npm at least at the versions [Requirements](requirements.md)
names.

> **Pin an exact version.** Every release is a prerelease that may break the
> API, and a range would let npm move you to the next one. `init` writes exact
> versions for you.

## Scaffold a language

```bash
npx @hydranium/cli init ./my-lang --name MyLang --heads lsp,data,glsp --hosts browser
```

`init` writes a complete project: its packages and a starter workspace, each in
its own directory.

- `server/` holds a starter grammar in `src/grammar/`, the services wiring, a
  server entry that starts every head, and build and test scripts.
- `protocol/` holds what the server and its clients both import: language ids,
  wire types and, with a diagram, its type ids. A client depends on it instead
  of the server.
- `client/`, with a diagram, holds the diagram's client side, which every host
  mounts.
- `host-browser/` holds a page that runs every head in a web worker, with no
  backend.
- `workspace/` holds two starter model files, one referencing the other.

Three flags shape it:

- `--heads` picks the heads: LSP serves text editors, data serves forms and
  tools, GLSP serves a diagram. Leave `glsp` out for a language without one.
  Leave `lsp` out and the server entry takes the workspace path as its
  argument and prints the ports of the heads it started.
- `--hosts` adds host applications around the heads. `browser` emits the page
  and needs the `lsp` head or the `glsp` head, which the page saves through:
  without `lsp` it has no editor and saves through the diagram. Leave it out
  for a server you connect to from your own host.
- Leave `--name` off on a terminal and `init` asks instead, then prints the
  command it composed.

`npx @hydranium/cli init --help` lists every option.

## Build and test

```bash
cd my-lang
npm install
npm run build    # generate the AST and the transfer model, compile every package
npm test         # the server's tests, starting with one that composes your services
```

Each package's own README describes the files `init` wrote there.

## Open it in a browser

```bash
npm run start:browser
```

Open the URL it prints. The page shows the starter files in an editor
with diagnostics, the diagram of the file picked at the top, and a line read
through the data head. Edit a file and press Save: the worker keeps the file in
the browser's storage, so it survives a reload.

```bash
npm --prefix host-browser run test:e2e:install   # once: the Chromium the smoke test drives
npm --prefix host-browser run test:e2e
```

The smoke test checks the same things and fails on any console error. It
serves the page itself, so stop `start:browser` first.

## Validate a model

The starter grammar declares nodes, each of which may point at another.
`workspace/references.my-lang` points at a node declared in
`workspace/nodes.my-lang`:

```bash
npx hydranium-cli validate --services ./server/lib/node/services.js ./workspace
```

It reports no problems. Change `Second` in `references.my-lang` to `Missing`
and run it again. This time it reports the unresolved reference with its
position and exits non-zero, so you can use it as a check in CI.

## Look at the language with the CLI

```bash
npx hydranium-cli reflect --services ./server/lib/node/services.js        # types, terminals, cross-references
npx hydranium-cli lint-grammar --services ./server/lib/node/services.js   # grammar conventions, as a CI check
npx hydranium-cli model-docs --services ./server/lib/node/services.js --out-file model-reference.md
```

Each reads the built services. Edit the grammar, rebuild, and run them again to
see the language as it is.

## Where to go from here

- **Understand what you built.** [How it works](../concepts/how-it-works.md)
  explains the heads and the one shared workspace behind them.
  [bookstore](../../examples/bookstore/README.md) is what `init` gives you;
  read it beside your own project.
- **Build a complete application.**
  [order-flow](../../examples/order-flow/README.md) is the application behind
  the [live demo](https://eclipse-emfcloud.github.io/hydranium/): three grammars
  that reference each other, all three heads, and Theia, VS Code and browser
  hosts. The [guides](../ADOPTING.md#guides) walk through the common tasks, and
  [customizing services](../concepts/customizing-services.md) shows where a real
  language changes the defaults.

To wire Hydranium into an existing project instead of a scaffold, see
[Compose a server by hand](../guides/compose-a-server.md).
