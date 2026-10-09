# Host in a browser

Use this when your language should run in a plain web page, with no backend:
every head in a web worker, the editors and the diagram in the page. The
[order-flow browser example](../../examples/order-flow/browser/README.md) does
everything below with all three heads; each step names the file to look at.

Heads: LSP · data · GLSP

## The seam

The heads' `.` entries run anywhere, a browser included. Anything that needs
Node sits behind a `/node` subpath, such as `@hydranium/core/node`, and your
browser bundle must not import one. The GLSP head has a `/browser` subpath for
its worker launcher. Run all heads in one worker, so they share one workspace.

## Steps

1. **Bundle for the browser.** Build with esbuild at `platform: 'browser'`, and
   alias the bare specifier `'path'` to a POSIX shim: one framework module
   imports it for a seam a browser never calls. Alias nothing else. A real Node
   import anywhere then fails your build, which is the check you want, rather
   than failing at runtime in a worker with no console. If you mount a diagram,
   add `loader: { '.ttf': 'dataurl' }` for GLSP's font.

2. **Give every head its own `MessagePort`.** The page creates one
   `MessageChannel` per head and transfers the ports to the worker in a
   bootstrap message. Never bind a head to the worker's global scope: heads on
   one global read each other's messages, and GLSP posts a startup string
   there whatever you configure. Connect each port through
   `createMessagePortTransport` from `@hydranium/protocol`, at both ends, so
   that closing a connection on one end closes the head on the other. On the
   LSP port's close, call `TextDocuments.closeLanguageClientDocuments()`, since
   a worker has no process to exit. See `src/head-channels.ts`.

   Start the GLSP head on its port:

<!-- snippet-preamble
import { LogLevel, ServerModule } from '@eclipse-glsp/server';
import type { DiagramModule } from '@eclipse-glsp/server';
import type { ServerSharedServices } from '@hydranium/core';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
declare const shared: ServerSharedServices;
declare const myDiagramModule: DiagramModule;
// The port the host transferred in, spelled the way the option type spells it —
// this gate compiles without the DOM lib, so `MessagePort` has no name here.
declare const transferredPort: {
   postMessage(message: unknown): void;
   addEventListener(type: 'message', listener: (event: unknown) => void, options?: unknown): void;
   removeEventListener(type: 'message', listener: (event: unknown) => void, options?: unknown): void;
   start(): void;
};
-->

```ts
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';

startGlspServerInWorker({
   context: transferredPort,
   createLogger: caller => new GlspClientLogger(shared, { logLevel: LogLevel.info, component: caller }),
   serverModule: new ServerModule().configureDiagramModule(myDiagramModule),
   appModules: [new HydraniumGlspAppModule({ shared })]
});
```

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
   the files in memory and mirrors every write to a store you supply: three
   async methods over IndexedDB or whatever the page has. Await it before you
   create the services, since a message that arrives while the worker is still
   awaiting is lost:

<!-- snippet-preamble
import type { FileSystemStore } from '@hydranium/core';
declare const store: FileSystemStore;
-->

```ts
import { persistentFileSystem } from '@hydranium/core';

const fileSystem = await persistentFileSystem({
   store,
   rootUri: 'file:///order-flow',
   seed: { 'orders/orders.domain': 'project orders' }
});
```

   The seed is the baseline and the store holds the changes, so a returning
   visitor gets their edits over your latest seed. A save fails when the store
   refuses the write, as it will when the quota is full. The store is shared by
   every page on the origin, so name it after your app. Once the store can
   differ from the seed, open your editors on the text the worker holds, not on
   the seed in your bundle: an editor opened on the seed overwrites the restored
   document.

5. **Validate once the workspace is up.** The first build of the workspace does
   not validate, so a page that only waits sees no diagnostics at all. Once
   `WorkspaceManager.workspaceInitialized` resolves, build every document with
   `{ validation: true }`. See `src/worker/order-flow-worker.ts`.

6. **Save through the data head.** An editor's `didSave` writes nothing: LSP
   leaves the write to the client, and a page has no disk. Save with the data
   head's `saveModelDocument`, which writes in the worker. A diagram edit
   reaches the editor first, so one save covers both.

7. **Show the server's log.** The server logs every head over LSP
   `window/logMessage`, and a page with no handler loses all of it. Register
   the handler before the language client starts, so you also see the first
   build, and keep only the newest lines. See `src/page/log-panel.ts`.

8. **Mount the diagram.** Connect GLSP's `BaseJsonrpcGLSPClient` over the GLSP
   port: build a `MessageConnection` on the port's transport and wrap it with
   `sendByMethodName` from `@hydranium/protocol`. Upstream's
   `GLSPWebWorkerProvider` starts a worker of its own, so it is not the piece
   to use. Then supply what a shell would:
   - size the `<svg>` to its mount, as in `#mount > svg { width: 100%; height:
     100% }`, or the diagram draws only what fits in 300×150;
   - give the mount a height and `position: relative`, so the tool palette
     stays on it;
   - use the mount element's id as the diagram's `clientId`;
   - bind `TYPES.IContextMenuService` to a no-op, so GLSP stops warning about
     it.

   For touch, set `touch-action: none` on the mount and re-emit pointer events
   as mouse events, skipping real mouse pointers, with one `mousemove` before
   the `mousedown`. Without it, a finger drag moves nothing, or drops the node
   at `0,0`. See `src/page/process-diagram.ts`.

9. **Make the text editor a full client.** In the example, Monaco talks LSP
   over the LSP port (`src/page/monaco-lsp-adapter.ts`). Three things a shell
   would otherwise do:
   - Without a TextMate grammar, turn on `highlightKeywords` and
     `highlightComments` in your semantic token provider's options, so the
     server colours those too. A host with a grammar leaves them off.
   - Go-to-definition needs `monaco.editor.registerEditorOpener` to open a
     target in another document. Read both answer shapes, `Location` and
     `LocationLink`, and put the caret on `targetSelectionRange`. For a target
     with no text behind it, such as a built-in library, tell the user and stay
     put: an editor opened on made-up text would overwrite the server's copy.
   - Register a document-highlight provider, and map its kinds: LSP numbers
     them from 1 and Monaco from 0. Without the provider, Monaco's own
     whole-word highlighting stands in and differs only in the cases that
     matter, such as a name inside a comment.
   - Handle `workspace/applyEdit`: the server sends one for every change a
     diagram or another client makes to an open document. Answer
     `applied: false` with a reason for an edit you will not apply, and echo
     applied edits as incremental `didChange`s, as any LSP client does.

## When something stays silent

- **The worker does not start, and the error says nothing.** A `Worker` URL
  resolves against the page, not the module creating it. Derive it from your
  build, and report the URL you tried.
- **The worker failed, and the console is empty.** Errors thrown in the
  workspace walk become unhandled rejections in the worker. Add `error` and
  `unhandledrejection` listeners in the worker that post to the page.
- **A diagram never loads in an automated test.** It renders on animation
  frames, which a hidden tab never gets. Drive tests with Playwright, whose
  headless Chromium counts as visible.
- **The data head's diagnostics requests fail.** Server state, heap snapshots
  and profiling need Node, so in a browser they reject; latency still works.

Two limits hold for any browser host: a page or worker that dies ends no
session, since a port cannot report it, and a closing tab cannot wait for a
save. See
[Status and limitations](../adopting/status.md#unsaved-edits-are-kept-only-so-far).

## Going further

[Browser hosting](../contributing/design/browser-hosting.md) explains the
packaging gate behind the `.` and `/node` split, and why the browser bundle is
still the stricter check.
