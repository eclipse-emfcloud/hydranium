# Host in a browser

Use this when your language should run in a plain web page, with no backend:
every head in a web worker, the editors and the diagram in the page. The
[order-flow browser example](../../examples/order-flow/browser/README.md) does
everything below with all three heads; each step names the file to look at.

Heads: LSP · data · GLSP

## The seam

The heads' `.` entries run anywhere, a browser included. Anything that needs
Node sits behind a `/node` subpath, such as `@hydranium/core/node`, and your
browser bundle must not import one. What starts a head in a worker sits behind
a `/browser` subpath of its package. Run all heads in one worker, so they share
one workspace.

## Steps

1. **Bundle for the browser.** Build with esbuild at `platform: 'browser'`, and
   alias the bare specifier `'path'` to a POSIX shim: one framework module
   imports it for a seam a browser never calls. Alias nothing else. A real Node
   import anywhere then fails your build, which is the check you want, rather
   than failing at runtime in a worker with no console. If you mount a diagram,
   add `loader: { '.ttf': 'dataurl' }` for GLSP's font. If you minify, keep
   class names (`keepNames`): the log tags the framework's and sprotty's
   classes by name.

2. **Give every head its own `MessagePort`.** In the page, build the `Worker`
   and hand it to `connectWorkerHeads` from `@hydranium/client-browser`, which
   creates one `MessageChannel` per head and transfers the ports to the worker
   in the framework's bootstrap message. In the worker, answer that message
   with `hostHeadsInWorker` from `@hydranium/core/browser`: it calls your
   `start` with the ports, and you start each head on its port with the
   starter from its package. Never bind a head to the worker's global scope:
   heads on one global read each other's messages, and GLSP posts a startup
   string there whatever you configure. Each starter connects its port so that
   closing a connection on one end closes the head on the other; the LSP
   starter also closes the language client's documents when the page closes
   its end, since a worker has no process to exit. Keep `start` synchronous,
   as its type says: a message that arrives while the worker awaits between
   building a head and listening is lost. See `src/worker/order-flow-worker.ts`.

   Import `reflect-metadata` first in the worker's entry, before any module
   with an Inversify decorator. GLSP's server classes read their metadata when
   they are defined, so a later import gives a container that resolves
   nothing, with errors naming an injected parameter rather than the import.

<!-- snippet-preamble
import { LogLevel, ServerModule } from '@eclipse-glsp/server';
import type { DiagramModule } from '@eclipse-glsp/server';
import type { ServerSharedServices } from '@hydranium/core';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import type { Connection } from 'vscode-languageserver';
declare const fileSystem: Promise<object>;
declare function createMyServices(context: { connection: Connection }): { shared: ServerSharedServices };
declare const myDiagramModule: DiagramModule;
-->

```ts
import { hostHeadsInWorker, startLanguageServerInWorker } from '@hydranium/core/browser';
import { DataServer } from '@hydranium/data-server';
import { startDataServerInWorker } from '@hydranium/data-server/browser';
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';

hostHeadsInWorker(fileSystem, (ports, restored) => {
   const shared = startLanguageServerInWorker(ports.lsp, connection => createMyServices({ connection, ...restored }).shared);
   startDataServerInWorker(ports.data, shared, connection => new DataServer(connection, shared));
   const glsp = startGlspServerInWorker({
      context: ports.glsp,
      createLogger: caller => new GlspClientLogger(shared, { logLevel: LogLevel.info, component: caller }),
      serverModule: new ServerModule().configureDiagramModule(myDiagramModule),
      appModules: [new HydraniumGlspAppModule({ shared })]
   });
   return { shared, started: [glsp.started] };
});
```

   Hand back the GLSP head's `started`, since that head reports a failed
   launch through it rather than by throwing; without a diagram, return the
   shared tier alone. Once `start` has returned and every `started` has
   resolved, the page is told the heads are up. A failure in `start`, in what
   you prepared, or in a head's `started` ends the page's heads; a failure
   later reaches the page as a report, which `onWorkerError` delivers. Report
   a failure of your own with `reportWorkerError`.

3. **Give the workspace a filesystem.** Without one, reads fail and writes go
   nowhere. For content held in memory, spread `inMemoryFileSystem` where a
   Node host spreads `NodeFileSystem`:

```ts
import { inMemoryFileSystem } from '@hydranium/core';

// Seed keys are relative to `rootUri`.
const fileSystem = inMemoryFileSystem({
   rootUri: 'file:///order-flow',
   seed: { 'orders/orders.domain': 'project orders' }
});
```

   A provider of your own must be writable, or the framework ignores it and
   the workspace looks empty, and it must answer Langium's synchronous reads,
   so an async store such as IndexedDB cannot sit behind it directly.

4. **Keep edits across a reload, if you want to.** `persistentFileSystem` keeps
   the files in memory and mirrors every write to a store.
   `IndexedDbFileSystemStore` from `@hydranium/core/browser` is one; a store of
   your own is three async methods over whatever the page has. Hand its
   promise to `hostHeadsInWorker`, which awaits it before `start`, since a
   message that arrives while a head is awaiting is lost:

```ts
import { persistentFileSystem } from '@hydranium/core';
import { IndexedDbFileSystemStore } from '@hydranium/core/browser';

const fileSystem = persistentFileSystem({
   store: new IndexedDbFileSystemStore('my-app-workspace'),
   rootUri: 'file:///order-flow',
   seed: { 'orders/orders.domain': 'project orders' }
});
```

   The seed is the baseline and the store holds the changes, so a returning
   visitor gets their edits over your latest seed. A save fails when the store
   refuses the write, as it will when the quota is full. The database is shared
   by every page on the origin, so name it after your app. Once the store can
   differ from the seed, open your editors on the text the worker holds, not on
   the seed in your bundle: an editor opened on the seed overwrites the restored
   document. The provider's `restoredPaths` names the files that came out of
   the store, and the store's `clear()` returns the next load to the seed.

5. **Validate once the workspace is up.** The first build of the workspace does
   not validate, so a page that only waits would see no diagnostics at all.
   `hostHeadsInWorker` builds every document with validation once
   `WorkspaceManager.workspaceInitialized` resolves, and reports a build that
   fails.

6. **Save through the LSP head.** An editor's `didSave` writes nothing: LSP
   leaves the write to the client, and a page has no disk. Call `save(uri)` or
   `saveAll()` on the `MonacoLspClient` you build in step 9. Each asks the
   worker to persist the text every `didChange` already gave it, in a request
   the LSP starter answers and advertises, so a page with only text editors
   needs no other head. The worker refuses a document whose buffer does not
   hold its text, such as while a server edit is still on its way to the
   editor; the document stays unsaved for the next save. A diagram edit
   reaches the editor first, so one save covers both.

7. **Show the server's log.** The server logs every head over LSP
   `window/logMessage`, and a page with no handler loses all of it. Pass the
   handler as `onLogMessage` to `initializeLanguageClient`, which registers it
   before the connection listens, so you also see the first build, and keep
   only the newest lines. See `src/page/log-panel.ts`.

8. **Mount the diagram.** Build `HydraniumGlspClient` from
   `@hydranium/glsp-client` over the GLSP head's connection from
   `connectWorkerHeads`, wrapped with `sendByMethodName` from
   `@hydranium/protocol`, and hand it with your diagram module's initializer
   and the element to `mountGlspDiagram`. Upstream's `GLSPWebWorkerProvider`
   starts a worker of its own, so it is not the piece to use. The mount adds
   the framework's client module, so a failed load and sprotty's own errors
   reach your logger instead of vanishing, and supplies what a shell would:
   framing, canvas bounds that follow the element's size and position, touch
   input and a context menu GLSP stops warning about. The page supplies the
   element's CSS: a height and `position: relative`, so the tool palette stays
   on it; `touch-action: none`, or the browser takes a finger drag as a pan;
   and the `<svg>` sized to it, as in
   `#mount > svg { width: 100%; height: 100% }`, or the diagram draws only what
   fits in 300×150. See `src/page/process-diagram.ts`.

9. **Make the text editor a full client.** Run the handshake with
   `initializeLanguageClient` from `@hydranium/client-browser`: it answers the
   server's capability registrations and its configuration request, which the
   server sends while the workspace comes up, then sends `initialize` and
   `initialized`. Pass it `MONACO_CLIENT_CAPABILITIES` from
   `@hydranium/client-browser/monaco` as `capabilities`, which declares what
   the Monaco client renders. In its `beforeInitialized` hook, once the
   server's answer is known, build a `MonacoLspClient` from
   `@hydranium/client-browser/monaco` over the connection with your language
   table and register your diagnostics handler, which hands each notification
   to the client's `applyDiagnostics`; a second handler for the same
   notification replaces the first. The client registers the languages and
   the providers, answers `workspace/applyEdit`, and sends `didOpen`,
   `didChange` and `didClose` for the documents you open through it. What
   stays yours (`src/page/monaco-setup.ts`):
   - Tell Monaco where its editor worker is. Assign `self.MonacoEnvironment`
     with a `getWorker` that builds the worker from a path your build gives
     you, at module scope, before any editor or model exists.
     `monaco-editor-core` ships no editor-worker entry, so bundle one of your
     own (`src/page/monaco-editor-worker.ts`). Left out, Monaco asks for a
     script no bundle emits, and the error appears only on the first edit.
   - Without a TextMate grammar, turn on `highlightKeywords` and
     `highlightComments` in your semantic token provider's options, so the
     server colours those too, and add theme rules named by your server's
     token types. A host with a grammar leaves them off.
   - Open each editor's document with `openDocument`, on the text the worker
     holds, and create the editor with `createEditor`, which keeps the
     settings a server-driven language needs under your theme and layout.
   - Go-to-definition needs an opener for a target in another document: pass
     yours to `registerEditorOpener`. For a target with no text behind it,
     such as a built-in library, answer `false` and tell the user: an editor
     opened on made-up text would overwrite the server's copy.

## When something stays silent

- **The worker does not start, and the error says nothing.** A `Worker` URL
  resolves against the page, not the module creating it. Derive it from your
  build, and report the URL you tried.
- **The worker failed, and the console is empty.** A failed workspace walk,
  a failed validating build and an unhandled rejection in the worker are
  reported to the page by `hostHeadsInWorker`; show what `onWorkerError`
  reports. An uncaught throw reaches the page as the `Worker`'s own `error`
  event, which `connectWorkerHeads` reports too.
- **A diagram never loads in an automated test.** It renders on animation
  frames, which a hidden tab never gets. Drive tests with Playwright, whose
  headless Chromium counts as visible.
- **A write never finishes, and every later build waits.** A model-service
  write or `rebuild` started from an integrity rule, a build-phase pass or a
  build listener waits for its own build; a Node host rejects it, a browser
  host cannot. Keep writes out of build callbacks, as
  [where you wait or write](../concepts/document-layers.md#waiting-for-a-current-model)
  says.
- **The data head's diagnostics requests fail.** Server state, heap snapshots
  and profiling need Node, so in a browser they reject; latency still works.

Limits that hold for any browser host: a page or worker that dies ends no
session; a worker that fails before its heads are up has its pending requests
rejected, but one that dies later leaves them waiting, since a port cannot
report either; and a closing tab cannot wait for a save. See
[Status and limitations](../adopting/status.md#unsaved-edits-are-kept-only-so-far).

## Going further

[Browser hosting](../contributing/design/browser-hosting.md) explains the
packaging gate behind the `.` and `/node` split, and why the browser bundle is
still the stricter check.
