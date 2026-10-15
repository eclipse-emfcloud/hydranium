# bookstore-host-vscode

Bookstore in VS Code: the language client, and a custom editor drawing each
diagram file. The server is started by `../vscode-servers`, whose launch this
extension calls, so the two never hand the server different documents. It needs
a Node extension host: the server is forked, and its socket heads are reached
over TCP.

The data head runs too, and its port is one `findPort` call away, from
`@hydranium/client-vscode`, but nothing here reads it yet: see the Host in VS
Code guide for a webview over it.

```bash
npm run build              # copy the server’s grammars, type-check and compile, then bundle
npm start                  # VS Code with this extension, on ../workspace; needs `code` on the PATH
npm run test:e2e:install   # download the VS Code the smoke test drives, once
npm run test:e2e           # the smoke test; under `xvfb-run -a` on Linux without a display
```

## Layout

- `src/extension.ts` — activation: the server, through `../vscode-servers`, and the diagram editors
- `src/bookstore-diagram-editor.ts` — the `Bookstore` diagram’s custom editor; its view type is the one `package.json` declares
- `src/webview/bookstore-diagram.ts` — the webview it loads, over the client package’s diagram
- `src/webview/diagram.css` — the webview’s size and colours
- `esbuild.mjs` — bundles each webview into `out/webview/`
- `start.mjs` — `npm start`: VS Code with this extension, on `../workspace`
- `test/smoke.spec.mts` — VS Code opens the workspace, the diagram draws, and the server reports a broken reference
- `test/vscode-version.mts` — the VS Code release the smoke test runs
