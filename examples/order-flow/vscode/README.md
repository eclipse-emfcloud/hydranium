# `@hydranium/example-order-flow-vscode`

The **VS Code extension** for the order-flow example: all three heads in one
Node extension host — the LSP head as a language client, the data head under a
properties webview, the GLSP head under a `.process` diagram editor.

**This is the long shell, and that is what it demonstrates.** The framework
ships Theia client packages and no VS Code equivalents, so every adapter layer
that [`../theia`](../theia/README.md) inherits is written out here: the socket
the extension host holds on the webview's behalf, the `postMessage` hop across
the sandbox boundary, the two webview documents and their CSP. What sits _above_
those layers — the diagram definition, `OrderFlowPropertiesModel`,
`PropertiesForm` — is mounted verbatim from
[`../client`](../client/README.md), which is the claim the split exists to make.

The server launch itself is **not** here: it lives in
[`../vscode-servers`](../vscode-servers/README.md) and is shared, so the two
hosts cannot drift on `documentSelector` or the file watcher.

## What it contributes

- One command, `order-flow.properties.show` — _Order Flow: Show Properties_.
- One custom editor, `orderFlow.processDiagram`, selecting `*.process` at
  `priority: "option"`. **Deliberately not `default`**: a `.process` file is
  primarily text, so the diagram is reached through _Open With_ / _Reopen Editor
  With_ rather than by stealing the double-click.
- The three languages and their TextMate grammars, and two settings
  (`order-flow.log.level`, `order-flow.trace.server`).

`contributes` is read statically, so none of those values can be imported from
the source that must match them — a mismatch is silent in both directions
(_Open With_ offers no diagram, and the provider binds a view type nothing
opens). The constraints are recorded in the manifest's own `//customEditors`
note.

## Two webviews, two dependency graphs, one build file

`esbuild.mjs` emits `out/webview/properties.js` and `out/webview/diagram.js`
with different options on purpose:

- The **diagram** bundle wants the `@eclipse-glsp/client` graph, so it gets the
  stylesheet handling and a `dataurl` loader for the font a webview cannot fetch
  by relative path.
- The **properties** bundle deliberately has neither, so a stray
  `@eclipse-glsp/client` import fails the build here instead of killing
  activation later with `Unexpected token '.'` — the first character of a CSS
  selector, reported with no hint that a stylesheet is involved.

At `platform: 'browser'` esbuild refuses a `node:*` builtin rather than shimming
it, which makes each bundle its own neutrality gate. Two repo gates back that
up: `check:host-load` requires the built `main` in bare Node with `vscode`
stubbed, and `check:webview-csp` rejects `eval` / `new Function` in a bundle
whose document withholds `'unsafe-eval'` — neither of these two documents grants
it.

## Extension-host wiring worth knowing

- **Both socket ports are discovered, not configured.** They are ephemeral and
  published as LSP requests, so `awaitPort` polls the running language client
  (40 attempts, 500 ms apart) — bounded, unlike the framework's Theia-side
  default, so a wrong command id surfaces as an error instead of hanging. The
  poll re-runs per connection generation, because a restarted server binds a
  fresh port.
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

Two time-wasters:

- **`syntaxes/` is copied at build time** from the server's `langium generate`
  output, which is gitignored — so the server must be built first. `build:all`
  handles that; a bare `build` in a clean tree does not.
- **The F5 launch opens `../workspace`, the shared test fixture, in place.** A
  properties-panel write reserializes the whole document. Check
  `git status examples/order-flow/workspace` afterwards — and see
  [the workspace README](../workspace/README.md) for what else edits it and what
  is exempt.
