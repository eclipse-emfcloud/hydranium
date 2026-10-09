# `@hydranium/example-order-flow-vscode`

The **VS Code extension** for the order-flow example: all three heads in one
Node extension host — the LSP head as a language client, the data head under a
properties webview, the GLSP head under a `.process` diagram editor.

The framework ships Theia client packages and no VS Code equivalents, so every
adapter layer that [`../theia`](../theia/README.md) inherits is written out
here: the socket the extension host holds for the webview, the `postMessage`
hop across the sandbox boundary, and the two webview documents with their CSP.
What sits _above_ those layers — the diagram definition,
`OrderFlowPropertiesModel`, `PropertiesForm` — is mounted unchanged from
[`../client`](../client/README.md).

The server launch is **not** here: it lives in
[`../vscode-servers`](../vscode-servers/README.md) and is shared, so the two
hosts cannot drift on `documentSelector` or the file watcher.

## Where to look

| Concern                          | Files                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| activation, and what it wires    | [`extension.ts`](src/extension.ts)                                                                                                            |
| finding the socket heads' ports  | [`head-ports.ts`](src/head-ports.ts)                                                                                                          |
| the properties panel             | [`properties-panel.ts`](src/properties-panel.ts), [`data-hop.ts`](src/data-hop.ts), [`webview/properties.ts`](src/webview/properties.ts), [`webview/properties-data-port.ts`](src/webview/properties-data-port.ts) |
| the `.process` diagram editor    | [`process-diagram-editor.ts`](src/process-diagram-editor.ts), [`process-diagram-server.ts`](src/process-diagram-server.ts), [`webview/diagram.ts`](src/webview/diagram.ts) |
| the two webview bundles          | [`esbuild.mjs`](esbuild.mjs)                                                                                                                  |
| what the extension contributes   | `contributes` in [`package.json`](package.json)                                                                                               |
| the extension-host tests         | [`test/host/`](test/host/), [`.vscode-test.mjs`](.vscode-test.mjs)                                                                            |
| the webview end-to-end tests     | [`test/e2e/`](test/e2e/), [`playwright.config.mts`](playwright.config.mts)                                                                    |
| the pinned VS Code build         | [`test/vscode-version.mts`](test/vscode-version.mts), [`scripts/install-vscode.mts`](scripts/install-vscode.mts)                              |

## What it contributes

The manifest declares the command `order-flow.properties.show` (_Order Flow:
Show Properties_), the custom editor `orderFlow.processDiagram`, the three
languages with their TextMate grammars, and the settings `order-flow.log.level`
and `order-flow.trace.server`. The editor selects `*.process` at
`priority: "default"`, so double-clicking opens the diagram and the text editor
is under _Open With_, the same way round as the Theia app.

VS Code reads `contributes` statically, so none of those values can be imported
from the source that must match them, and a mismatch compiles. The manifest's
`//customEditors` note records what must match what, and `test:host` checks the
editor a `.process` opens in.

## Two webviews, two dependency graphs

`esbuild.mjs` emits `out/webview/properties.js` and `out/webview/diagram.js`
with different options on purpose:

- The **diagram** bundle wants the `@eclipse-glsp/client` graph, so it gets the
  stylesheet handling and a `dataurl` loader for the font a webview cannot fetch
  by relative path.
- The **properties** bundle has neither, so a stray `@eclipse-glsp/client`
  import fails the build here instead of killing activation later with
  `Unexpected token '.'` — the first character of a CSS selector, reported with
  no hint that a stylesheet is involved.

At `platform: 'browser'` esbuild refuses a `node:*` builtin rather than shimming
it, so each bundle fails its own build on one.

## Extension-host wiring worth knowing

- **Both socket ports are discovered, not configured.** They are ephemeral and
  published as LSP requests, so `awaitPort` polls the running language client,
  bounded by its `attempts` and `intervalMs` defaults — unlike the framework's
  Theia-side default, so a wrong command id surfaces as an error instead of
  hanging. The poll re-runs per connection generation, because a restarted
  server binds a fresh port.
- **The GLSP head resolves its port at first diagram open**, not during
  activation, so a user who never opens a diagram pays nothing.
- **One `vscode-messenger` `Messenger` serves both webviews**, and it must have
  `ignoreHiddenViews: false`. The library defaults it to `true`, which drops
  every host→webview notification for a tab that is not the visible one in its
  group — and the data head's _responses_ travel as notifications, so the
  webview's requests would hang with no rejection.

## Building and running

```bash
npm --prefix examples/order-flow/vscode run build:all   # this package + its deps
npm --prefix examples/order-flow/vscode run build       # this package only
npm --prefix examples/order-flow/vscode run watch       # tsc
npm --prefix examples/order-flow/vscode run watch:webview
```

Then in VS Code, **Run Order Flow VS Code Extension — order-flow-workspace**
(F5). _Run Order Flow VS Code Extension + Attach to Server_ is the compound that
also attaches to the forked server on port 6009.

- **`syntaxes/` is copied at build time** from the server's `langium generate`
  output, which is gitignored — so the server must be built first. `build:all`
  handles that; a bare `build` in a clean tree does not.
- **The F5 launch opens `../workspace` in place.** Read the
  [order-flow README](../README.md#the-fixture-workspace-is-edited-in-place) on
  the fixture workspace before you edit anything in a session.

## Tests

```bash
npm --prefix examples/order-flow/vscode test              # vitest, in `check`
npm --prefix examples/order-flow/vscode run test:host     # extension host, real VS Code
npm --prefix examples/order-flow/vscode run test:e2e      # webviews, Playwright
```

The last two launch the VS Code build pinned in `test/vscode-version.mts`,
downloaded into `.vscode-test/` on first use, on a scratch copy of
`../workspace`. They read the built `out/` and the packages it loads, so run
`build:all` first, and without a display prefix them with `xvfb-run -a`.
Neither is in `check`; CI runs both in its `e2e (vscode)` job, after
this package's `test:e2e:install` has downloaded the build with retries. Once
it is cached, neither tier makes a request to VS Code's update server.

- **`test:host`** runs `test/host` with Mocha inside the extension host,
  through `@vscode/test-cli` and `.vscode-test.mjs`. It sees what the extension
  API exposes: activation, the editor a `.process` opens in, the server's
  diagnostics, the port commands and the properties panel's tab. It cannot see
  inside a webview.
- **`test:e2e`** drives the VS Code window with Playwright's Electron support
  and asserts inside the webviews. Its selectors reach into the workbench DOM,
  which is not a VS Code API, so a version bump can break them.

## Changing this example

Two repo gates read this package's output: `check:host-load` requires the built
`main` in bare Node with `vscode` stubbed, and `check:webview-csp` rejects
`eval` / `new Function` in a bundle whose document withholds `'unsafe-eval'`.
Neither webview document grants it.
