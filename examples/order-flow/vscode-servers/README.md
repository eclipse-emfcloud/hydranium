# `@hydranium/example-order-flow-vscode-servers`

A **servers-only VS Code extension**: it launches the order-flow language server
and republishes both socket-head ports as host commands. No editor, no view, no
command-palette entry.

It is step 1 of [Host in Theia](../../../docs/guides/host-in-theia.md): the
guide says why a Theia app sideloads this instead of the full VS Code shell.
[`../theia`](../theia/README.md) owns the Theia UI, and
[`../vscode`](../vscode/README.md) owns the VS Code UI.

## Where to look

| Concern                                        | Files                                                   |
| ---------------------------------------------- | ------------------------------------------------------- |
| the server launch and the port commands        | [`src/language-client.ts`](src/language-client.ts)      |
| activation                                     | [`src/extension.ts`](src/extension.ts)                  |
| activation event, languages and grammars       | [`package.json`](package.json)                          |

## What is specific to this package

- **One launch, two hosts.** The VS Code shell imports `src/language-client.ts`
  too, because a drift here is invisible: a different `documentSelector` or
  file watcher changes which documents the server sees, and the feature just
  goes quiet in one host.
- **The port command handlers are thin pass-throughs, and must stay so.**
  Awaiting a VS Code notification inside one would make the return value wait
  on a human dismissing a popup, which in Theia hangs the backend with nothing
  logged.
- **Registered at runtime, contributed by nothing.** Registering is enough to
  run a command programmatically, and contributing these two would put
  diagnostics-only entries in a product's command palette.
- **`onStartupFinished`, not `onLanguage:*`.** A backend forwarder may poll a
  port command before any order-flow document is open.

## Packaging

Plain `tsc` to CommonJS in `out/`, with `main` at `./out/extension.js`; nothing
in this graph reaches a browser, so there is no bundler. The Theia app symlinks
the package into `plugins/` (its `link:plugin` step), and the VS Code shell
imports `out/language-client` by module path.

`languages` and `grammars` are duplicated from the VS Code shell's manifest on
purpose: each extension must stand alone in whichever host installs it. The
TextMate grammars are copied by `copy:grammar` from the server's
`langium generate` output, which is gitignored, so **build the server first**.

## Building

```bash
npx turbo run build --filter=@hydranium/example-order-flow-vscode-servers...
npm --prefix examples/order-flow/vscode-servers run build   # server already built
npm --prefix examples/order-flow/vscode-servers run lint
```

Nothing here runs on its own. To see it work, start
[`../theia-app`](../theia-app/README.md) or press F5 on
[`../vscode`](../vscode/README.md). It has no test script: the Theia app's
Playwright suite and the port-command unit test in `../theia` cover it in
Theia, and `../vscode`'s `test:host` runs its language client and port
commands in VS Code.
