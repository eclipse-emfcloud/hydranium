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
npx @hydranium/cli init ./my-lang --name MyLang --heads lsp,data,glsp --hosts browser,vscode
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
- `host-vscode/` holds a VS Code extension: the language client, a Show Model
  command reading a file through the data head, and a custom editor for the
  diagram. It starts the server through `vscode-servers/`, an extension with
  no editor.
- `theia/` and `host-theia-browser/`, with `--hosts theia-browser`, hold a
  Theia extension forwarding the data and GLSP heads, with the same command
  and the diagram editor, and the Theia browser application running it, with
  `vscode-servers/` sideloaded for the language client.
- `host-theia-electron/`, with `--hosts theia-electron`, holds the same
  application in Electron, running the same `theia/` extension.
- `workspace/` holds two starter model files, one referencing the other.

Three flags shape it:

- `--heads` picks the heads: LSP serves text editors, data serves forms and
  tools, GLSP serves a diagram. Leave `glsp` out for a language without one.
  Leave `lsp` out and the server entry takes the workspace path as its
  argument and prints the ports of the heads it started.
- `--hosts` adds host applications around the heads. `browser` emits the page
  and needs the `lsp` head or the `glsp` head, which the page saves through:
  without `lsp` it has no editor and saves through the diagram. `vscode` emits
  the two extensions, and `theia-browser` and `theia-electron` the Theia
  extension and an application; all three need the `lsp` head, since the
  language client starts the server. Leave `--hosts` out for a server you
  connect to from your own host.
- Leave `--name` off on a terminal and `init` asks instead, then prints the
  command it composed.

`npx @hydranium/cli init --help` lists every option.

## Build and test

Build on the Node version in the scaffold's `.nvmrc`.
[Requirements](requirements.md#node-2213-or-newer) says why and how to switch
with nvm.

```bash
cd my-lang
npm install
npm run build    # generate the AST and the transfer model, compile every package
npm test         # the server's tests, starting with one that composes your services
```

Each package's own README describes the files `init` wrote there.

## Rebuild as you work

After one `npm run build`, keep everything built while you edit:

```bash
npm run watch:browser   # or watch:vscode, watch:theia-browser, watch:theia-electron
```

A grammar change regenerates the AST and the transfer model, every package
recompiles, and the host you named rebundles; reload it to see the change.
`npm run watch` alone keeps the packages built without any host. Ctrl+C stops
everything.

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

## Open it in VS Code

```bash
npm run start:vscode
```

VS Code opens `workspace/` with the extension loaded, which needs `code` on
your `PATH`. `nodes.my-lang` opens as its diagram, and Reopen Editor With
offers the text editor, where the server reports problems as you type.

```bash
npm --prefix host-vscode run test:e2e:install   # once: the VS Code the smoke test drives
npm --prefix host-vscode run test:e2e
```

The smoke test runs Show Model, opens the diagram and checks that the server
reports a broken reference. On Linux without a display, run it under
`xvfb-run -a`.

## Open it in Theia

Scaffolded with `--hosts theia-browser`:

```bash
npm run start:theia-browser
```

Theia serves `workspace/` at http://localhost:3000; `THEIA_PORT` picks
another port. `nodes.my-lang` opens as its diagram, Open With offers the text
editor, and `MyLang: Show Model` in the Command Palette reads the active file
through the data head.

```bash
npm --prefix host-theia-browser run test:e2e:install   # once: the Chromium the smoke test drives
npm --prefix host-theia-browser run test:e2e
```

The smoke test starts the application itself, on a port of its own, so
`start:theia-browser` can keep running.

Scaffolded with `--hosts theia-electron`:

```bash
npm run start:theia-electron
npm --prefix host-theia-electron run test:e2e
```

The same application opens `workspace/` in a desktop window, and the smoke
test launches its own window on a copy of it. On Linux without a display, run
the test under `xvfb-run -a -s '-screen 0 1920x1080x24'`.

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
