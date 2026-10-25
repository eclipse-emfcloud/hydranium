# `@hydranium/example-order-flow-theia-electron-app`

The **Theia Electron application** that hosts the order-flow example: the
desktop counterpart of [`../theia-app`](../theia-app/README.md), loading the
same [`../theia`](../theia/README.md) extension and sideloading the same
[`../vscode-servers`](../vscode-servers/README.md). How to build one for your
language: [Host in Theia](../../../docs/guides/host-in-theia.md).

| Concern | Where |
| --- | --- |
| The application: target, extensions, connection settings | the `theia` block and dependencies of [package.json](package.json) |
| The bundle | [esbuild.mjs](esbuild.mjs), as `theia build` generates it |
| The e2e tier | [playwright.config.mts](playwright.config.mts), running [`../theia-app/test/e2e/`](../theia-app/test/e2e/) |

## Running it

```bash
npm run build:all
npm --prefix examples/order-flow/theia-electron-app start
```

`start` opens `../workspace` in place; read the
[order-flow README](../README.md#the-fixture-workspace-is-edited-in-place)
before you edit anything in a manual session.

**There is no `theia rebuild:electron`.** Theia's native modules are N-API
builds, which load in Electron and in Node alike, so this application uses
the root `node_modules` as installed.

## The e2e suite

```bash
npm run build:all
npm --prefix examples/order-flow/theia-electron-app run test:e2e
```

It runs the browser app's specs against this application, with `USE_ELECTRON`
set so `TheiaAppLoader` from `@theia/playwright` launches Electron instead of
opening a page. The reload spec and the restart and reconnect tiers stay with
the browser app.

Pitfalls:

- **Theia sizes its window to two thirds of the screen**, and the specs are
  written for 1280x720. Under `xvfb-run`, pass `-s '-screen 0 1920x1080x24'`;
  at its default screen a diagram node falls outside the canvas.
- **The tier caps its workers** (`workers` in the config). Each one runs a
  whole application, and more at once start slower than a spec's `beforeAll`
  allows.
