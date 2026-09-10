# `@hydranium/example-order-flow-browser`

The order-flow language server running **entirely in a web worker** — no Node
runtime, no backend process, no socket.

**This is the reference browser deployment — the one to copy.** All three heads
share one worker and one Langium store; a plain page drives them over three
`MessagePort`s and gives them a GLSP diagram, three Monaco editors, a navigable
workspace and a theme.
There is no shell, no extension host and no build step a host framework performs
on your behalf, so everything a browser host has to supply is visible in this
package and nothing is hidden by one.

"Can a head run in a browser at all" is the easy question, and it is settled.
What the package is *for* is the harder one behind it: what a host has to do
that a shell was doing for it. Five things, each with the failure
it produces when skipped, all recorded here and in
[`docs/concepts/browser-hosting.md`](../../../docs/concepts/browser-hosting.md):
size the elements sprotty and Monaco render into, hand each head its own port,
ask for the validating build workspace initialization does not do, answer
`workspace/applyEdit`, and — since nothing else will — write the files, because
LSP puts the file write on the client and a page is a client with no disk.

The three bundles, because a page whose subject is what its bundle contains
should state it: **10.8 MB** for the page, **3.0 MB** for the head worker,
**625 kB** for Monaco's editor worker — about **14.5 MB** in total, of which
Monaco is roughly 8 MB. Read those as a measurement rather than a fact about
your build: taken unminified against `monaco-editor-core` 0.56, and no gate
asserts them, so a dependency bump moves them without anything here noticing.
Nothing is minified or split, deliberately: a worker-hosted language server
can only be debugged in devtools.

## Running it

```bash
npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser start   # http://localhost:3002/
```

Or from VS Code, **Start Order Flow Browser Page (:3002)** — it builds, runs the
static server as the debuggee, and opens Chrome against it once the server prints
its URL. Breakpoints in the page read as written; the three heads run in a web
worker, which appears as its own target in the call-stack view.

**`?locale=de` renders the server's messages in German** —
`http://localhost:3002/?locale=de`. The page reads the tag off its own URL and
declares it in LSP `initialize`, the server hands it to
`OrderFlowMessageRenderer`, and the diagnostics in the problems list come back
translated. Try it on `orders/audit-leak.domain`'s unresolved reference: that
sentence is **Langium's**, not this example's, and it arrives in German because
the framework claims it as `hydranium/core/unresolved-reference` and the server
renders before publishing. Nothing on the page holds a catalogue.

A query parameter rather than a picker, and rather than `navigator.language`: the
point is to switch it in one reload while watching the same diagnostics, and you
cannot ask a reader to change their browser's language to see a feature. Any
other tag falls back to English, which is the same pass-through an adopter with
no entry for a code gets. A worker has no host to ask for a language — no
`vscode.env.language`, no Theia `localeId` — so declaring one is the page's job
here, and `initialize` is the same slot every other host uses.

The page starts the worker, hands each head its own `MessageChannel`, sends LSP
`initialize` for a workspace it never had on disk, and reports five things: the
diagnostics the LSP head publishes, one document read back through the data
head, a `.process` diagram rendered by the GLSP head, the current contents of
`orders/fulfillment.layout` — which changes when you drag a node — and where the
workspace itself came from, seed or storage.

Below the diagram, `orders/fulfillment.process` and `orders/fulfillment.layout`
open in two Monaco editors over the same LSP channel: type an error and the
squiggle comes from the server, and the highlighting is the server's semantic
tokens rather than a client-side grammar. Comments are deliberately uncoloured —
there is no TextMate or Monarch grammar anywhere in this page, and a comment is a
hidden lexer token that never reaches the AST the server tokenises.

**That pair is PINNED and a third editor is not.** Every claim this page makes is
about a relationship between two documents — a drag rewriting one and not the
other, a rename reaching both, a save writing one of the two that are open — and
none of them is observable with a single document on screen. So the pair stays
under the diagram it is a view of, and the workspace list on the left drives a
separate lookup editor beside it. The list marks the two states differently: a pin
for the pair, the accent bar for the selection.

**Drag a node and watch the `.layout` editor, not just the report line.** That is
`workspace/applyEdit` arriving — the diagram→text direction, and the one thing on
this page that makes it a client of a framework seam no other host has exercised.
The framework mirrors a server-side write to whichever client holds the document
open, as a *minimal* edit computed against a shadow of that client's buffer; the
page applies it through `pushEditOperations`, so Ctrl+Z in the editor reverses a
diagram drag.

Two things this settled by measurement, both of which the design left open:

- **The framework does not gate the request on a client capability.** It goes out
  on every server-side write to an open document, whatever the client declared —
  so a client that sends `didOpen` and has no `applyEdit` handler answers
  `MethodNotFound`, the framework logs it over `window/logMessage`, and a page
  with no handler for *that* loses the whole inbound direction in silence — a
  state a page reaches by adding editors and stopping there.
- **The echo does not loop, and the page deliberately does not suppress it.**
  Applying the edit makes Monaco emit a `didChange`, and one drag costs exactly
  one inbound request with no push after it, so nothing ping-pongs. That echo
  carries *incremental* ranges addressing the text as it stood before the push,
  and the server reconciles them against the pre-push text it kept for each
  in-flight push, so an echo is recognised and consumed rather than re-applied.

  Echo incrementally, exactly as a conforming client does, and work around
  nothing. The echo is what keeps the server's shadow and per-client version
  aligned with this buffer, so suppressing it here would break the next outbound
  diff. `vscode-languageclient` echoes incrementally too, so this is the
  ordinary contract rather than a quirk of a hand-written client — see
  [browser hosting](../../../docs/concepts/browser-hosting.md#two-obligations-on-a-host-that-accepts-workspaceapplyedit).

**Put the caret inside `Order.status` and press Ctrl+Space.** That line —
`task Pay writes Order.status = PAID` — is three references, each scoped by the
previous one: the field list is `Order`'s and no one else's, and the literal list
is `OrderStatus`'s because that is what `status` is typed as. Completion is the
only thing on this page that shows the *candidate set* rather than the result, so
it is where the three-level scope provider becomes visible. Hovering any of the
three names renders the declaration it resolves to, which for `Order` lives in a
different grammar and a file the page never opened.

One caveat, and it is the server's rather than the page's: **asking at a
truncated reference (`writes Order.` and then Ctrl+Space) makes the request
hang** — the document never reaches a state the completion handler answers at.
Ask at an existing reference. `examples/order-flow/server`'s
`lsp-harness.integration.test.ts` records the same thing.

Drag `Cancel` to see the interesting case: the fixture gives it no layout entry,
so moving it *creates* one. It is also the only node whose position nobody chose
— a flow node with no entry is left to client layout and lands at the origin,
which is the normal state for anything added in text — so the seeded entries
deliberately start clear of that corner, and `Cancel` reads as the gateway's `no`
branch leaving the main line rather than as a shape dropped on another one.

The rest of the model is placed left to right by rank, with the gateway's two
exits splitting vertically, which is what makes the diamond worth drawing: each
branch leaves a different face of it. The page **frames** the model in its pane
on load rather than leaving it anchored top-left, so the layout can be a
statement about the flow instead of about what happens to fit in a pane of one
particular width.

**Light and dark come from one switch**, and the page has three things to move
where a shell would have none: its own chrome, the `--order-flow-*` colour roles
the diagram is painted from, and Monaco's theme. Only the last is not CSS. The
roles are the interesting part — the diagram module needs no change, because
`@hydranium/example-order-flow-client`'s stylesheet paints from a role
vocabulary a host fills in, exactly as
`examples/order-flow/vscode/src/webview/diagram.css` binds it to `--vscode-*`.
This page supplies only the **light** half and lets the shared stylesheet's dark
defaults stand, so the fallback path is on the normal route rather than untested.
The page chrome reads the same roles, which is what makes one switch enough.

The initial scheme follows `prefers-color-scheme`; the switch overrules it. The
choice is deliberately not persisted, unlike the workspace: a stored scheme would
be read during startup, which makes every run depend on what the last one left
behind, where the workspace's store is asked for its content at a point the page
controls.

**Press *save workspace* and reload.** The edit is still there — and *without*
the save it is not, which is the same bargain a Node host offers: an edit lives in
the server's in-memory text document until something persists it. Writes mirror
into `IndexedDB` behind
[`PersistentFileSystemProvider`](../../../packages/core/src/langium/workspace/persistent-file-system-provider.ts),
and the next load restores them before the heads start; *reset workspace* drops
them and returns to the committed fixtures, which a page that can save a
document that no longer parses genuinely needs.

Four things this arrangement is worth reading for, because each one is a decision
a host has to make and none of them is obvious:

- **The store holds the delta, not the workspace.** Only what was written lands
  in it, laid over the generated seed on load — so editing a fixture in the
  repository still reaches a reader who once pressed save, and the database stays
  a few kilobytes. A deletion is therefore stored as a *marker* rather than as an
  absence — dropping the entry for a seeded file would return it to its seeded
  content on the next load, which is a delete that undoes itself. Nothing on this
  page deletes files, so the marker path is framework-side only for now.
- **The save goes through the DATA head, not through `didSave`.** LSP puts the
  file write on the client: `textDocument/didSave` tells the server a save
  happened and the framework answers it by firing `onDidSave` — it writes
  nothing. A shell does the writing; this page cannot, so it asks the worker to,
  with `saveModelDocument`. Sending `didSave` would persist nothing at all,
  silently.
- **The editors take their text from the worker, not from the generated seed.**
  Once anything is stored the two differ, and `didOpen` is authoritative — so an
  editor opened on the committed bytes would overwrite the restored document in
  the server's text store and undo the reload, with both sides parsing and the
  diagnostics agreeing. The worker sends the workspace it actually came up on,
  once the heads are live.
- **Only dirty documents are saved.** Both editors are open; a diagram drag
  changes one. Saving the other would pin its current bytes in storage, where
  they win over the seed forever — so a later fixture edit would never reach
  anyone who had pressed save.

Storage is origin-scoped and the browser may evict it, which presents as a first
visit — a state the provider is correct in. A store that *fails* is not
swallowed: the save reports it, because a page that claims to have saved and then
loses the workspace is worse than one that says it could not.

**The dock has the server's log**, which is what a Theia or VS Code shell gives
a language server for free as an output channel and a plain page has to build.
One panel covers all three heads: the framework's logger routes through the
shared services' LSP connection, so a data-head read and a GLSP write arrive on
the same `window/logMessage` channel as the LSP head's own lines — you can watch
`WorkspaceManager`, `HydraniumGlspServer` and `TextDocuments` interleave on one
timeline.

It is not decoration. Before it existed, everything the server logged went
nowhere, and that is precisely how the whole inbound direction of the sync stayed
broken and invisible: the framework reported the failure at `error`, over this
channel, to a page that was not listening.

**Nothing on this page is collapsed by default**, and that is a consequence of
the layout rather than a preference. As `<details>` in a footer the log and the
problems list would take their height from the editors, so either one open
shrinks the document a diagram write appends to below the thing it exists to
show. As their own resizable track they cost the editors nothing, and a reader
who wants the height back drags a divider instead of hunting for a disclosure
triangle. Every area of the page is resizable that way, and *reset layout*
restores the defaults.

**Each editor opens scrolled to its declaration, not to line 1.** Every fixture
in this workspace opens with a comment block written for a reader of the
repository, and `fulfillment.layout`'s runs past thirty lines before the `layout`
block a diagram drag rewrites — so an editor left at the top would show nothing
but prose and a drag would appear to change nothing. The line is derived (the
first that is neither blank nor `//`), so editing a fixture header cannot leave
the page scrolled into the middle of a comment.

## Reading the result

The oracle is the same workspace validated from Node:

```bash
npx hydranium-cli validate --services ./examples/order-flow/server/lib/services.js ./examples/order-flow/workspace
```

Both should report the same documents and the same diagnostics, at the same
positions. A shorter list in the browser means documents the workspace walk
never reached — the failure this seeding arrangement is most likely to produce,
and the reason the comparison is worth making rather than eyeballing the page
for plausibility.

The diagram's oracle is the same diagram in `examples/order-flow/theia-app`:
same document, same client module, a shell and a backend instead of a page and a
worker. `orders/fulfillment.process` has five flow nodes and four connections.

Or let the e2e tier read the result for you:

```bash
npm --prefix examples/order-flow/browser run test:e2e:install   # once
npm --prefix examples/order-flow/browser run build
npm --prefix examples/order-flow/browser run test:e2e
```

It asserts all three heads against those counts, that the graph fills its mount
(see below), that a drag and a palette create reach the `.layout` document, that
the drag also reaches the `.layout` *editor*, and that the console is **silent** —
the console is this host's only log, so a warning nobody needs is what teaches a
reader to skim the one place real failures appear.

**Editing is asserted against the layout DOCUMENT, not against the diagram.**
sprotty draws a dragged node at the drop point whether or not the operation ever
reached the source model, so the render would pass against a server that dropped
the write. The page reads the file back through the data head instead — a
different head than the one that wrote, over the same Langium store.

An edit does not touch `examples/order-flow/workspace`. A diagram operation goes
through `ModelService.update`, which rewrites the in-memory text document and
rebuilds; only an explicit save reaches the (seeded, in-memory) filesystem. So
`git status` after a browser run should be clean, and a change there would be a
real finding.

Deliberately not wired to `test`, so `npm run check` needs no browser binary —
the same posture as the Theia app's tier. The worker head's *launch* surface is
covered inside `check` and headless, by
`packages/glsp-server/test/start-glsp-server-in-worker.test.ts`; what only this
tier can cover is a GLSP model reaching a rendered view.

**A diagram will not load in a hidden tab.** sprotty renders on
`requestAnimationFrame`, and the dispatch that starts the load only resolves
once a frame has rendered — so a minimised or occluded window produces a page
stuck on `loading…` with a clean console and nothing on the wire. It presents as
flakiness in the code and is not.

## What is here, and what is not

| | |
| --- | --- |
| LSP head | ✅ in the worker |
| Data head | ✅ on its own channel, same worker, same Langium store |
| GLSP head | ✅ on a third channel, via `@hydranium/glsp-server/browser` |
| Diagram editing | ✅ a drag and a palette create, both read back through the data head |
| Text editors | ✅ three Monaco editors over the same LSP channel — diagnostics as markers, highlighting from semantic tokens, completion and hover |
| Workspace navigation | ✅ every seeded document with its diagnostic count, and a problems list that opens a document at the line |
| Diagram → text | ✅ `workspace/applyEdit` applied to the Monaco models, so a drag moves the `.layout` editor |
| Light / dark | ✅ one switch over the page chrome, the `--order-flow-*` diagram roles and Monaco's theme; seeded from `prefers-color-scheme` |
| Server log | ✅ a dock panel over `window/logMessage`, carrying all three heads on one channel, filterable |
| Resizable layout | ✅ pointer-event dividers on every area, no UI framework — the shape GLSP's own `workflow-standalone` example uses |
| Workspace persistence | ✅ a save mirrors into `IndexedDB` and the next load restores it, seed as the baseline; *reset* drops it |
| Creating / deleting / renaming files | ❌ the filesystem takes all three and a deletion is durable, the page has no UI to ask for any of them |

**Monaco, hand-glued — not `monaco-languageclient`.** The whole LSP client is
`src/page/monaco-lsp-adapter.ts`, over the *same* `MessagePort` the diagnostics
report uses. `monaco-languageclient` would drag in the
`@codingame/monaco-vscode-*` shim stack, which destroys the one property that
makes this bundle worth having: at `platform: 'browser'` esbuild refuses a
`node:*` builtin rather than shimming it, so the bundle is a stricter neutrality
gate than `check:neutral`. A package whose subject is what its bundle contains
should not shim half of VS Code inside it.

**`monaco-editor-core`, not `monaco-editor`.** The wrapper package is core plus
eighty bundled language definitions, and a page whose entire subject is that its
language comes from a *server* should ship none of them. Core's entry carries
every editor contribution and no grammars. It costs two files: one assembles the
worker entry the wrapper would have shipped, and one declares it.

**Highlighting comes from the server, so there is no second grammar.** No Monarch
or TextMate definition accompanies the three languages — `OrderFlowSemanticTokenProvider`
is one `$type`-keyed map over all three, and the page feeds Monaco from it. One
definition of the language, so there is nothing to drift.

Two things that bite here, both of which look like the server having failed:

- **A standalone-Monaco theme rule's `token` is matched against the semantic
  token TYPE NAME**, not against a TextMate scope the way VS Code's
  `semanticTokenScopes` works. A theme written the VS Code way loads without
  complaint, Monaco still splits each line into one span per token, and every
  span resolves to the default foreground.
- **Monaco 0.56 drives its editor with the EditContext API**, so the
  `textarea.inputarea` that every older automation recipe names does not exist.
  Drive it by clicking a rendered `.view-line`.

**The diagram definition is not in this package.** It is
`@hydranium/example-order-flow-client`'s, mounted verbatim — the same module the
Theia and VS Code shells load. What a browser host contributes is the transport,
GLSP's standalone modules, a light colour-role set, and two load-bearing CSS
rules; see `src/page/process-diagram.ts` and the `<style>` block in `index.html`,
both of which say why each piece is load-bearing.

**The workspace SEED is committed, and regenerated by every build.**
`scripts/generate-workspace-seed.mjs` bakes `examples/order-flow/workspace` into a
module, and `build` runs it before anything compiles, so the models this host
opens cannot drift from the ones the VS Code and Theia hosts open. It is
the baseline rather than the content: what the heads come up on is the seed with
whatever storage holds laid over it, which is why only the worker reads it and the
page is told the result.

The framework-level version of what this package learned —
what a browser host must accommodate, and why — is
[`docs/concepts/browser-hosting.md`](../../../docs/concepts/browser-hosting.md).

## Three things to know before changing it

- **No head may bind the worker global.** Each gets a `MessagePort` transferred
  at bootstrap. `src/head-channels.ts` explains why — briefly, GLSP's launcher
  posts a non-JSON-RPC startup string through the global `postMessage` no matter
  how it is configured, and two readers on one global receive each other's
  traffic. Both halves are now observed rather than anticipated: with three
  heads live it is the only protocol traffic on the global, and each port carries
  only its own protocol. What the global does carry besides it is this package's
  own host protocol — bootstrap, the workspace the heads came up on, a
  persistence reset, failure reports — and that line is the one to hold.
- **Workspace initialization does not validate.** Langium builds it with
  validation off, so a client that connects and waits sees a healthy server
  reporting nothing at all. Asking for the trailing validating build is the
  host's job; `src/worker/order-flow-worker.ts` does it and says why.
- **Nothing asynchronous may sit between the LSP reader and `listen`.** The
  stored workspace is restored *before* the connection is constructed, and that
  is not tidiness: `BrowserMessageReader` starts its port as it is built but fires
  into an emitter with no listener until `startLanguageServer` calls `listen`, so
  an `initialize` that arrives during an intervening `await` is dropped — no
  error, no reply, a page that waits forever. `persistentFileSystem` is
  asynchronous for exactly this reason, so the wait happens where it is safe.

The bundle is also a neutrality gate in its own right, covering this example's
real composition rather than the framework's entries alone — see
[browser hosting](../../../docs/concepts/browser-hosting.md#a-note-on-what-gated-neutral-does-and-does-not-promise).
