# `@hydranium/example-order-flow-vscode-servers`

A **servers-only VS Code extension**: it launches the order-flow language server
and republishes both socket-head ports as host commands. No editor, no view, no
command-palette entry.

**It exists so a Theia app can sideload the server without inheriting a second
diagram editor.** A Theia product needs a VS Code extension host to fork the
language server and to answer the port commands its backend forwarders poll —
but hosting the _full_ VS Code shell also registers that shell's
`contributes.customEditors`, and `.process` ends up with two _Open With_
entries. That is a property of shipping both hosts at all, not a shortcut this
example takes.

So the division is: this package owns hosting the server,
[`../theia`](../theia/README.md) owns the Theia UI, and
[`../vscode`](../vscode/README.md) owns the VS Code UI.

## What it demonstrates that no sibling does

- **One launch, two hosts.** `src/language-client.ts` is imported by the VS Code
  shell as well as used here, because the launch is exactly the part whose drift
  is invisible: a different `documentSelector` or file watcher changes which
  documents the server ever sees, and nothing fails — the feature just goes
  quiet in one host and not the other.
- **Fork over IPC**, not stdio. The extension host is Node, and IPC keeps stdout
  free, which matters because the server's GLSP head routes its logs over the
  LSP connection precisely to avoid corrupting a stdio transport.
- **LSP request ids republished as host command ids.** The server answers
  `order-flow/...` port requests; this extension registers
  `order-flow.port.dataServer` and `order-flow.port.glsp`, which is what a Theia
  `CommandService` can execute. The handlers are thin pass-throughs and must
  stay that way — awaiting a VS Code notification inside one would make the
  return value wait on a human dismissing a popup, which in Theia hangs the
  backend forever with nothing logged.
- **Registered at runtime, contributed in the manifest by nothing.** Registering
  is sufficient to invoke a command programmatically, and contributing these two
  would put diagnostics-only entries in a product's command palette.
- **`onStartupFinished`, not `onLanguage:*`.** A backend forwarder may poll a
  port command before any order-flow document is open — the diagram or the
  properties view can be the first thing a user touches.

## Packaging

Plain `tsc` to CommonJS in `out/`, with `main` at `./out/extension.js`. There is
no bundler here and no need for one: nothing in this graph reaches a browser.

It is consumed **two ways, neither of them an install**:

- the Theia app symlinks it into `plugins/` (its `link:plugin` step) and Theia
  deploys it as a local plugin;
- the VS Code shell imports `out/language-client` **by module path**, not
  through a barrel, because this package has no public API surface of its own.

`languages` and `grammars` are duplicated from the VS Code shell's manifest on
purpose — each extension must be self-sufficient in whichever host installs it,
and only the runtime launch is shared. The three TextMate grammars are copied by
`copy:grammar` from the server's `langium generate` output, which is gitignored,
so **the server has to be built first**.

## Building

```bash
npx turbo run build --filter=@hydranium/example-order-flow-vscode-servers...
npm --prefix examples/order-flow/vscode-servers run build   # server already built
npm --prefix examples/order-flow/vscode-servers run lint
```

Nothing here is launched on its own. To see it work, start
[`../theia-app`](../theia-app/README.md) (which sideloads it) or press F5 on
[`../vscode`](../vscode/README.md) (which imports its launch). It has no test
script — its behaviour is covered by the Theia app's Playwright tier and by the
port-command unit test in `../theia`.
