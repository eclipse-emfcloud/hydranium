# `@hydranium/example-order-flow-browser`

The order-flow language running entirely in a web page. The LSP, data and GLSP
heads share one web worker and one Langium store, with no Node runtime and no
backend. A plain page drives them over three `MessagePort`s and gives them a
GLSP diagram, three Monaco editors, a navigable workspace and a server log.

No shell does a host's work here, so everything a browser host has to supply
is in this package. For the steps themselves, read the guide
[Host in a browser](../../../docs/guides/host-in-a-browser.md); this README
shows you where each piece lives and how to see it work.

## Running it

```bash
npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser start   # http://localhost:3002/
```

From VS Code, **Start Order Flow Browser Page (:3002)** builds, serves and
opens Chrome. The heads run in a web worker, which appears as its own target in
the call-stack view. The bundles are not minified unless you pass `--minify` to
`esbuild.mjs`, so the worker stays debuggable in devtools.

## Try it

- **Switch the language** with the globe in the title bar, or open
  `http://localhost:3002/?locale=de`. The page chrome, the server's diagnostics,
  the tool palette and Monaco's own context menu move together. The unresolved
  reference in `orders/audit-leak.domain` is Langium's sentence, claimed as
  `hydranium/core/unresolved-reference`. Type `§` into `fulfillment.process` for
  chevrotain's lexer error, `hydranium/core/unexpected-character`. Type a bare
  `a` between two tasks and the parser objects instead; its four sentences are
  `hydranium/core/unexpected-token`, `hydranium/core/trailing-input`,
  `hydranium/core/no-viable-alternative` and `hydranium/core/missing-iteration`.
- **Complete along a reference chain.** Put the caret inside `Order.status` on
  `task Pay writes Order.status = PAID` and press Ctrl+Space: the fields
  offered are `Order`'s, and the literals after `=` are `OrderStatus`'s. Hover
  any of the three names to see its declaration. Ask at an existing reference:
  completion at a truncated `writes Order.` hangs, as the server's
  [`lsp-harness.integration.test.ts`](../server/test/lsp-harness.integration.test.ts)
  records.
- **Jump across grammars.** Ctrl+click `Order` in
  `process Fulfillment for Order`, and the lookup editor opens
  `orders/orders.domain` at `entity Order`.
- **See occurrence marks.** Leave the caret in `= PAID`. The server marks one
  occurrence, where Monaco's textual matcher would also mark `OrderStatus.PAID`
  in the comment above.
- **Drag `Cancel`.** It has no entry in `orders/fulfillment.layout`, so the drag
  creates one, and you watch it arrive in the `.layout` editor as a
  `workspace/applyEdit`. Ctrl+Z in that editor undoes the drag.
- **Edit in the properties panel.** It follows editor focus and runs on its own
  data-head session. Change `name` and the `.process` text rewrites.
- **Save and reload.** Press *Save workspace*, or Ctrl+S for the focused
  document, and reload: the edit is still there. Without the save it is not.
  *Reset workspace* returns to the committed fixtures.
- **Open *Latency* in the status strip.** The worker builds one
  `LatencyCollector` and passes it to both the `DataServer` and the LSP
  connection, so LSP and data-head methods appear in one report.

## Where things are

| Concern | Files |
| --- | --- |
| The worker: all three heads, the filesystem, the validating build, latency | [src/worker/order-flow-worker.ts](src/worker/order-flow-worker.ts) |
| The bootstrap that hands each head its own port, shared by both ends | [src/head-channels.ts](src/head-channels.ts) |
| Persistence in IndexedDB | [src/workspace/indexeddb-file-system-store.ts](src/workspace/indexeddb-file-system-store.ts) |
| The bare `'path'` alias for the browser bundle | [src/workspace/posix-path-shim.ts](src/workspace/posix-path-shim.ts), [esbuild.mjs](esbuild.mjs) |
| The workspace seed | [scripts/generate-workspace-seed.mts](scripts/generate-workspace-seed.mts), [src/generated/workspace-seed.ts](src/generated/workspace-seed.ts) |
| The static server | [scripts/serve.mts](scripts/serve.mts) |
| Page entry: Monaco's locale, loaded before Monaco | [src/page/order-flow-page.ts](src/page/order-flow-page.ts), [monaco-editor-core-nls.d.ts](src/page/monaco-editor-core-nls.d.ts) |
| Page wiring: the three channels, save, dialogs, theme switch | [src/page/workbench.ts](src/page/workbench.ts) |
| DOM lookups and the element builder | [src/page/dom.ts](src/page/dom.ts) |
| Monaco's LSP client and editor themes | [src/page/monaco-lsp-adapter.ts](src/page/monaco-lsp-adapter.ts) |
| Monaco's editor worker | [src/page/monaco-editor-worker.ts](src/page/monaco-editor-worker.ts), [monaco-editor-core-worker.d.ts](src/page/monaco-editor-core-worker.d.ts) |
| The pinned editor pair and the lookup editor | [src/page/editor-area.ts](src/page/editor-area.ts) |
| The diagram mount | [src/page/process-diagram.ts](src/page/process-diagram.ts) |
| Touch drags on the diagram | [src/page/touch-input.ts](src/page/touch-input.ts) |
| The data-head port | [src/page/worker-data-port.ts](src/page/worker-data-port.ts) |
| The properties panel | [src/page/properties-panel.ts](src/page/properties-panel.ts) |
| The workspace list and problems list | [src/page/workspace-panel.ts](src/page/workspace-panel.ts) |
| The server log, its level and the message trace | [src/page/log-panel.ts](src/page/log-panel.ts), [src/page/log-controls.ts](src/page/log-controls.ts) |
| The status strip | [src/page/report-detail.ts](src/page/report-detail.ts) |
| The build stamp | [src/page/build-stamp.ts](src/page/build-stamp.ts) |
| Resizable areas | [src/page/splitters.ts](src/page/splitters.ts) |
| The narrow-viewport layout | [src/page/responsive.ts](src/page/responsive.ts) |
| Page translations | [src/page/page-nls.ts](src/page/page-nls.ts), [src/page/nls/](src/page/nls/) |
| Remembered language and colour scheme | [src/page/preferences.ts](src/page/preferences.ts) |
| Markup, English text, styles and colour roles | [index.html](index.html) |
| End-to-end tests | [test/e2e/](test/e2e/), [playwright.config.mts](playwright.config.mts) |

The diagram definition is not in this package. It is
[`@hydranium/example-order-flow-client`](../client/README.md)'s, mounted
verbatim, the same module the Theia and VS Code shells load.

## Checking results

The oracle is the same workspace validated from Node:

```bash
npx hydranium-cli validate --services ./examples/order-flow/server/lib/services.js ./examples/order-flow/workspace
```

Both should report the same documents and the same diagnostics, at the same
positions. A shorter list in the browser means documents the workspace walk
never reached. The diagram's oracle is the same diagram in
[`theia-app`](../theia-app/README.md): same document and client module, with a
shell and a backend instead of a page and a worker.

Or let the e2e tier check for you:

```bash
npm --prefix examples/order-flow/browser run test:e2e:install   # once
npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser run test:e2e
```

It asserts all three heads against the oracles' document, diagnostic, node and
edge counts, and that the console stays silent. It asserts that a drag and a
palette create reach the `.layout` document, read back through the data head
rather than from the rendered diagram, since sprotty draws a dragged node at
the drop point whether or not the write landed. Further Playwright projects
cover touch, a narrow viewport and a phone. A browser run leaves
`examples/order-flow/workspace` untouched, so `git status` should be clean
afterwards.

## What it covers

| | |
| --- | --- |
| LSP head | ✅ in the worker |
| Data head | ✅ on its own channel, same worker, same Langium store |
| GLSP head | ✅ on a third channel, via `@hydranium/glsp-server/browser` |
| Diagram editing | ✅ a drag and a palette create, both read back through the data head |
| Text editors | ✅ three Monaco editors over the LSP channel: diagnostics, semantic highlighting, completion, hover, go-to-definition, occurrence highlighting |
| Diagram → text | ✅ `workspace/applyEdit` applied to the Monaco models |
| Light / dark | ✅ one switch over the page chrome, the `--order-flow-*` diagram roles and Monaco's theme |
| Localization | ✅ one switch over the page chrome, the server's diagnostics and palette, and Monaco's menus |
| Server log | ✅ a dock panel over `window/logMessage`, all three heads on one channel |
| Resizable layout | ✅ pointer-event dividers on every area, no UI framework |
| Touch input | ✅ a node drag under a finger |
| Narrow viewport | ✅ one scrolling column; each editor is shielded until tapped |
| Workspace persistence | ✅ a save mirrors into IndexedDB and the next load restores it |
| Creating, deleting, renaming files | ❌ the filesystem supports all three; the page has no UI for them |

## Pitfalls

- **A standalone-Monaco theme rule's `token` matches the semantic token type
  name**, not a TextMate scope as VS Code's `semanticTokenScopes` does. A theme
  written the VS Code way loads without complaint, and every token renders in
  the default foreground.
- **Monaco drives its editor with the EditContext API**, so there is no
  `textarea.inputarea` for automation to type into. Click a rendered
  `.view-line` instead.
- **The workspace seed is committed and regenerated by every build** from
  `examples/order-flow/workspace`. That directory is not an npm workspace, so
  [turbo.json](turbo.json) lists it as an input; without it, a workspace edit
  replays a stale cached bundle.
