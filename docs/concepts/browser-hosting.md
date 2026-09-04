# Hosting a head in a browser

A hydranium head runs in a browser web worker with no Node runtime and no
backend process. This page is what an adopter needs to know before trying it:
what a browser host supports, the accommodations it has to make, and the one
behaviour that surprises everybody.

`examples/order-flow/browser` hosts **all three heads** in one worker over one
Langium store: over the same models, the LSP head reports the same diagnostics
per document as `hydranium-cli validate`, the data head agrees with it about
each of them, and the GLSP head renders a `.process` diagram. The full
capability list, and the one gap, is [at the end](#what-a-browser-host-supports).

## The packaging contract

Every head's `.` entry is free of `node:*` and is gated that way
(`scripts/check-neutral-bundles.mjs`). Anything Node-only lives behind a `/node`
subpath — `@hydranium/core/node`, `@hydranium/glsp-server/node` — and a browser
bundle must not import those.

The rule is mechanical: **`.` is portable, `/node` is server-only.**

It applies below the `.` entry too, and the gate covers more than the heads: the
portable client tiers (`@hydranium/protocol/client`, `/data`), the LSP head
(`@hydranium/core/lsp`), the Theia client packages, and the test-support surface
— `*/testing` holds the browser-neutral doubles while `*/testing/node` holds the
harnesses that need a real filesystem or a Node stream transport. The script's
`TARGETS` is the enumeration.

A few non-`/node` public subpaths are excluded on their merits — a harness with
no portable half to split off, a conformance slice that asserts with
`node:assert/strict` by design, a passthrough of an upstream Node-bound entry.
The reason for each is stated beside the exclusion list in the script, which is
where an adopter should read it: only being NAMED there separates a considered
exclusion from an oversight, so restating the list here would let a doc copy
drift into claiming coverage the gate does not give.

One head has a third spelling. `@hydranium/glsp-server/browser` is the mirror of
its `/node` twin — the reason is in
[Head module maps](head-module-maps.md#hydraniumglsp-server--graphical-head), and what matters
here is the consequence: `.` stays free of both so it resolves under either
platform, and eslint bans naming either from neutral code.

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
   start(): void;
};
-->

```ts
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';

startGlspServerInWorker({
   context: transferredPort, // required; see accommodation 2
   // The GLSP log threshold lives on the logger, not beside it — there is no
   // launcher-level `logLevel`, because the framework replaces GLSP's own
   // `Logger` binding and anything passed to its app module is discarded.
   createLogger: caller => new GlspClientLogger(shared, { logLevel: LogLevel.info, component: caller }),
   serverModule: new ServerModule().configureDiagramModule(myDiagramModule),
   appModules: [new HydraniumGlspAppModule({ shared })]
});
```

It returns an `IntegratedServer` **without** `port`: the socket variant's one
extra member is the one thing a worker head has no answer for.

## Accommodation 1 — alias the one bare `'path'` import

`@hydranium/core`'s workspace initialization imports bare `'path'`, not
`node:path`, precisely so a bundler can point it at a POSIX shim. It is the only
such import on the portable surface, and it is reached only by the headless seam
that accepts workspace folders as filesystem-path *strings* — a browser host
passes `WorkspaceFolder` URIs through LSP `initialize` instead, so the aliased
code does not run.

Alias the **bare specifier only**. Aliasing `node:*` as well would trade a build
error for a runtime one inside a worker with no console attached, and would
forfeit the property that makes the bundle worth having: at
`platform: 'browser'`, esbuild refuses to resolve a Node builtin rather than
shimming it, so a genuine Node import anywhere in the graph fails the build.

That property is worth more than it looks, and what it does and does not buy is
[at the end of this page](#a-note-on-what-gated-neutral-does-and-does-not-promise).

## Accommodation 2 — give every head its own `MessagePort`

Heads share one Langium store, so they share one worker. Never bind a head to
the worker global.

- `BrowserMessageReader` filters nothing, so two heads reading the global each
  receive the other's traffic. This is not a race that appears under load; it is
  every message delivered to the wrong reader.
- The global is unusable even for a *single* head, because GLSP's
  `WorkerServerLauncher` posts its startup handshake through the global
  `postMessage` regardless of the connection it was configured with. A
  JSON-RPC reader on the global therefore receives a bare string it cannot parse.

So: the page creates one `MessageChannel` per head and transfers the ports into
the worker in a bootstrap message; the global carries bootstrap and that stray
handshake only. Designing this in from the first head costs nothing; retrofitting
it when the second arrives touches every call site.

Measured with all three heads live: each head's port carries only its own
protocol — no LSP method on the data port, no GLSP action on either — and the
only protocol traffic on the global is GLSP's stray
`[GLSP-Server]:Startup completed.`. What else the global carries is the HOST's
own business: the bootstrap message, the workspace the heads came up on, a
persistence reset, failure reports. That split is the line to hold — a message
belonging to a head belongs on that head's port.

**The rule is a compile error in YOUR project, not in the framework's.**
`BrowserGlspServerOptions.context` is typed as a structural `MessagePort` whose
member set a `Worker` and a `DedicatedWorkerGlobalScope` do not satisfy, so
passing the global fails to build rather than producing a head that silently
reads everyone's traffic. That check fires where those names resolve — a worker
compiled against `lib.webworker`, a page against `lib.dom` — which is the
adopter's project, not `@hydranium/glsp-server`, whose own `lib` resolves neither.
Measured in `examples/order-flow/browser`: passing the global fails with
`Property 'start' is missing in type 'DedicatedWorkerGlobalScope'`.

(Upstream declares `WorkerLaunchOptions.context` as `Worker`, narrower than the
`MessagePort | Worker | DedicatedWorkerGlobalScope` its own reader accepts, so
the framework casts structurally on the way through. That cast is redundant
today and kept on purpose: `Worker` does not resolve under the framework's `lib`
either, so `skipLibCheck` degrades the option and the assignment would compile
without it — which would be type-checking by accident rather than by contract.)

For the same reason, upstream's `GLSPWebWorkerProvider` is **not** the page-side
piece: it constructs its own worker — a second Langium store — and reads the
worker object rather than a port. Build a `MessageConnection` over the port and
hand it to `BaseJsonrpcGLSPClient`, which takes any `ConnectionProvider`. No new
upstream package is needed.

## Not an accommodation — the data head's diagnostics default themselves

The data head's diagnostics requests need a process to inspect, and each names a
capability a browser genuinely lacks. The extension point is
`DataServerDiagnosticsProvider`, not `DataServer` — a host overriding one of
these implements the provider; `stopProfiling` ends the capture `startProfiling`
returned, and `getLatency` is on neither:

| Method | What it uses |
| --- | --- |
| `dumpServerState` | `process.memoryUsage()`, `v8.getHeapStatistics()`, `process.cpuUsage()`, `perf_hooks` event-loop utilisation |
| `writeHeapSnapshot` | `v8.writeHeapSnapshot()` writing a file |
| `dumpPodMemory` | reads the cgroup tree under `/sys/fs/cgroup` |
| `startProfiling` / `stopProfiling` | a `node:inspector` `Session` |
| `getLatency` | nothing — plain counters, portable, never moved |

**A host supplies nothing.** `package.json`'s `browser` field selects the Node
implementation on Node and a rejecting twin in a browser bundle — the same
mechanism `@eclipse-glsp/server` uses to swap its node build for its browser
one. `DataServerOptions.diagnostics` exists to override, not to be required.

The browser twin **throws** rather than no-ops: an empty snapshot reads as a
healthy server, which is the same shape as a real answer.

Worth knowing why there is no browser implementation rather than a missing one:
in a browser these measurements are taken from **outside** the page, over CDP —
which this repo already does (`hydranium-browser-heap`, `browser-runtime.json`,
the Playwright capture bridge). An in-process API is the wrong shape for them,
not an unfilled gap.

## Accommodation 3 — supply a filesystem

The `.` entry binds `DefaultEmptyFileSystemProvider` by default: reads throw and
writes are dropped. A browser host that means to open a workspace supplies its
own through the `context.fileSystemProvider` channel, exactly where a Node host
spreads `NodeFileSystem`.

Two things to get right:

- **The slot silently rejects a read-only provider.** It accepts what it is given
  only if that carries `writeFile`; anything else falls back to the empty
  default, which presents as "the workspace is empty" rather than as a wiring
  error.
- Langium's `FileSystemProvider` is ten methods wide (`stat`/`statSync`,
  `exists`/`existsSync`, `readBinary`/`readBinarySync`, `readFile`/`readFileSync`,
  `readDirectory`/`readDirectorySync`), plus the framework's `writeFile`. The
  optional `mtimeMs` and `realpath` may be omitted — the framework degrades
  rather than requiring stubs, since there is no disk to stat and no symlink to
  collapse.

A host that needs nothing more than real content in memory writes no provider at
all: `inMemoryFileSystem` binds an `InMemoryFileSystemProvider` off the `.`
entry, keyed by a `Map` with directories implied by the keys under them rather
than stored.

```ts
import { inMemoryFileSystem } from '@hydranium/core';

// Seed keys are relative to `rootUri`, which is what lets a build step emit the
// record without knowing where the host will mount the workspace.
const fileSystem = inMemoryFileSystem({
   rootUri: 'file:///order-flow',
   seed: { 'orders/orders.domain': 'project orders' }
});
```

Spread it where a Node host spreads `NodeFileSystem`. It is writable, so it
satisfies the slot's acceptance test above; it takes mid-run mutation through
`setFile` / `deleteFile`; and it serves a registered virtual document ahead of
the map, so a stdlib survives the rebuild that re-reads it.

What it deliberately does not answer is watch notifications, case-insensitivity,
and eviction for a workspace larger than memory.

### Making it survive a reload

**Do not put an async store directly behind the slot.** Langium's
`FileSystemProvider` is half SYNCHRONOUS — `statSync`, `readFileSync`,
`existsSync`, `readDirectorySync` — and the workspace walk uses them, so a
provider whose reads return promises cannot satisfy it however writable it is.
`IndexedDB` has no synchronous API at all; OPFS has synchronous file handles, and
only inside a worker, but enumerates a directory asynchronously — so an in-memory
index is required either way and OPFS buys nothing for a first cut.

So the map stays the read path and the store is durability behind it.
`PersistentFileSystemProvider` is `InMemoryFileSystemProvider` with exactly that:
writes mirror through at the one `setFile` chokepoint, and `persistentFileSystem`
restores the store into the map before the provider exists. A host supplies the
store — one interface, three methods, keyed in the same space as the seed.

<!-- snippet-preamble
import type { FileSystemStore } from '@hydranium/core';
// `IndexedDB`, a fetch cache, the editor's own filesystem API — whatever the host
// has. `load` / `write` / `remove`, all asynchronous.
declare const store: FileSystemStore;
-->

```ts
import { persistentFileSystem } from '@hydranium/core';

// AWAITED before the services exist, and that is the ordering contract rather
// than a convenience: a `BrowserMessageReader` starts its port on construction
// but drops every message until `startLanguageServer` calls `listen`, so an
// `initialize` arriving during a later await is lost with no error anywhere.
const fileSystem = await persistentFileSystem({
   store,
   rootUri: 'file:///order-flow',
   seed: { 'orders/orders.domain': 'project orders' }
});
```

Three properties worth knowing before building on it:

- **The seed is the baseline and the store is the delta.** A stored entry wins
  per key; a seeded file the store has never held is served from the seed. A first
  visit is therefore the seed exactly, and a fixture edited in the repository
  still reaches a returning visitor — which whole-store precedence would have
  hidden until they cleared their storage.
- **A deletion is stored as a marker, not as an absence.** A delta cannot express
  absence by omission: dropping the stored entry for a seeded file returns it to
  its seeded content on the next load, which is a deletion that undoes itself. So
  deleting a seeded path writes a tombstone, and re-creating the file is an
  ordinary write over it. A path the seed never carried is removed outright
  instead, so a host that creates and deletes scratch files does not grow the
  store forever. The marker is a reserved VALUE rather than a reserved key,
  because a key is a path by contract and a store may map keys to real filenames
  — the consequence being that a host reading the store directly sees markers
  among the content and cannot tell them apart.
- **A failed write reaches the caller.** `writeFile` awaits the mirror and rejects
  if the store refuses, so a save cannot report success for content no store
  holds. Browser storage genuinely fails: a quota is finite and the user agent may
  evict the whole origin. Eviction then presents as a first visit, which is a
  state the provider is correct in.
- **The store is origin-scoped, not page-scoped.** Every page on the origin shares
  it. Name the database for the app.

### A text client's `didSave` persists nothing

This one is a framework fact rather than a browser one, and it decides where a
browser host's save goes. LSP puts the file write on the CLIENT:
`textDocument/didSave` tells the server a save has happened, and the framework
answers it by firing `onDidSave` — it writes nothing. In Theia or VS Code the
shell does the writing, so nobody notices.

A page has no filesystem. The only end that can write is the worker, so the save
has to be a request the worker acts on — the data head's `saveModelDocument` in
`examples/order-flow/browser`. Sending `didSave` instead persists nothing at all,
silently.

Which makes the parity with a Node host exact rather than approximate: an edit
lives in the in-memory text document until something saves it, on both ends. A
diagram drag reaches the editor's buffer as a `workspace/applyEdit` first, so one
save covers both directions.

### Once the store can override the seed, the page must stop reading the seed

A host that bakes its workspace into the bundle naturally opens its editors on
the same generated record the filesystem was seeded from. That stops being
correct the moment anything is persisted: the filesystem is then the seed with
the stored edits over it, while `didOpen` is authoritative — so an editor opened
on the committed bytes OVERWRITES the restored document in the server's text
store and undoes the reload. Both sides parse, the diagnostics agree, and only
the content is a version old.

The worker's filesystem is the one source of truth for content, so the page has
to derive its editor text from it. `examples/order-flow/browser` sends the
workspace back on the bootstrap channel once the heads are live; a host with a
real workspace wants a per-document read instead of the whole thing.

## The behaviour that surprises everybody

**Workspace initialization does not validate.** Langium builds it with
`initialBuildOptions`, whose `validation` is unset, so every document stops at
`IndexedReferences` — no diagnostics computed, none published.

A client that connects, initializes and waits therefore sees a server that
started correctly, indexed the workspace, and says nothing at all. That is
indistinguishable from an empty workspace, and nothing anywhere logs the
difference.

Asking for the validating build is the host's job: build every registered
document with `{ validation: true }` once startup has settled
(`WorkspaceManager.workspaceInitialized` is the gate). This is the same trailing
build `buildWorkspaceProgrammatically` runs for the headless tools.

## Accommodation 4 — a diagram page supplies what a shell would

Mounting a GLSP diagram outside Theia or VS Code needs three things the shell
normally provides, and the bundle needs a font loader:

- **Size the `<svg>`.** sprotty sets no width or height on it, so without a CSS
  rule it takes the SVG default of 300×150 — and `ShapeView.isVisible` **culls**
  every element whose bounds fall outside the canvas. Measured: a five-node
  diagram drew two, the model complete and the hidden measuring view holding all
  of it. That reads as a server sending a partial model, which is the one thing
  it is not. `#mount > svg { width: 100%; height: 100% }`.
- **Give the mount `position: relative`.** GLSP's UI extensions — the tool
  palette above all — are absolutely positioned, and otherwise anchor to the
  viewport and float over the document.
- **Give the mount a height.** It is sized by CSS and has no content of its own.
- **`loader: { '.ttf': 'dataurl' }`.** `@eclipse-glsp/client`'s graph reaches
  stylesheets and a font. The stylesheets need no loader entry — esbuild writes
  them beside the JS — but a `file` loader for the font rewrites the CSS `url()`
  relative to the OUTPUT directory, which is not where the document lives.

The mount element's id is not free either: `configureDiagramOptions` derives
`ViewerOptions.baseDiv` from `IDiagramOptions.clientId`, so they are the same
string whether or not anyone intended it. A mismatch renders nothing and logs
one line.

One binding is worth adding too: `TYPES.IContextMenuService`. GLSP falls back to
a no-op and warns on the console for every container it builds, and in a browser
host the console is the only log there is — the worker posts its failures there
and the language server's lines arrive over the LSP channel. Binding the no-op
explicitly says the same thing without training the reader to skim.

## Accommodation 5 — a browser host has no output channel

Theia and VS Code hand a language server an output channel for free. A plain page
does not have one, and the framework's logger writes everything —
`WorkspaceManager`, `TextDocuments`, the project manager, and the GLSP server's
own lines — over LSP `window/logMessage`. **A page with no handler for that
notification discards the server's entire log**, silently, while looking healthy.

That is not a hypothetical cost. It is exactly how a whole direction of the
document sync stayed broken and invisible in the example: the framework reported
the failure at `error`, over this channel, to a page that was not listening. The
symptom was nothing at all.

The handler is small — render `params.message`, which the framework has already
formatted as `[Level - timestamp] [Component] message`, and use `params.type`
only to colour the line. Three things worth getting right, all of which the
example's footer panel does:

- **Register it before `listen()` and before `initialize` goes out.** The lines
  from the first workspace build are the ones a reader most wants when the page
  does not come up, and a handler attached after `initialize` resolves misses all
  of them.
- **Bound it.** The server logs per document per build phase, so a few edits
  reach the hundreds; drop the oldest.
- **One channel carries every head.** The framework's logger routes through the
  shared services' LSP connection, so a data-head read and a GLSP write arrive on
  the same channel as the LSP head's own lines — one panel shows all three
  interleaved on one timeline, which is the view no single head's transport can
  give.

## Two silent failures worth instrumenting up front

Both cost a debugging cycle in the example, and neither reports itself:

- **A `Worker` URL resolves against the document, not the calling module.** A
  wrong path 404s, and the resulting `ErrorEvent` carries no message, no filename
  and no line number — so the page cannot tell a missing script from a crash on
  the first statement. Derive the URL from the build rather than restating it,
  and report the URL you tried.
- **A rejecting LSP *notification* handler has no reply to reject.** The
  workspace walk runs under one, so anything it throws becomes an unhandled
  rejection in a worker nobody is watching. Register `error` and
  `unhandledrejection` handlers that post failures back to the page.

## A trap that belongs to whoever DRIVES the page, not to the code

**A diagram cannot load in a hidden tab.** sprotty's render loop is
`requestAnimationFrame`-driven, and the command stack resolves a dispatch only
once the update has rendered — so in a tab whose `document.visibilityState` is
`hidden`, `StatusOverlay.preInitialize` never resolves and
`DiagramLoader.load()` waits forever. No error, no console output, nothing on
the wire.

This is an automation artefact rather than a defect, and it presents exactly as
one: the same build loads in a foreground window and hangs when the window is
minimised or occluded, which reads as flakiness in the code. Drive a diagram
check with a browser you control — headless Chromium reports `visible`, so
Playwright is fine and `examples/order-flow/browser`'s `test:e2e` tier is the
worked example. If a load stalls with a clean console, check
`document.visibilityState` before anything else.

## What a browser host supports

All of it runs in `examples/order-flow/browser`: three heads in one worker over
one Langium store, no Node runtime, no backend process, no socket.

| Capability | What it rests on |
| --- | --- |
| LSP head in a worker | its own `MessageChannel` |
| Data head in a worker | a second `MessageChannel`, sharing the LSP head's Langium store |
| GLSP head in a worker | a third `MessageChannel`, same store, via `@hydranium/glsp-server/browser`. A `.process` diagram renders from the host-agnostic client module the Theia and VS Code shells also mount |
| Diagram editing in a worker | a drag and a palette create, including the multi-document write path where a create touches both the primary document and its layout secondary. An operation goes through `ModelService.update`, so nothing reaches the filesystem: the change lives in the in-memory text document until an explicit save |
| A full text-editor LSP client in the page | Monaco driven over the same transferred `MessagePort` the diagnostics arrive on: `didOpen` / `didChange` out, `publishDiagnostics` to markers, completion, hover, and highlighting from the server's semantic-token provider rather than any client-side grammar. A page is a full LSP client, not only a viewer — with [one composition choice](#the-composition-choice-a-page-makes-and-a-shell-must-not) attached |
| `workspace/applyEdit` inbound — the diagram→text direction | a diagram drag moves the `.layout` editor. The page resolves every target before writing any, then applies through `pushEditOperations` so the edit joins Monaco's undo stack. Accepting these carries [two obligations](#two-obligations-on-a-host-that-accepts-workspaceapplyedit) |
| Workspace persistence across a reload | `PersistentFileSystemProvider` mirrors every write into a host-supplied `FileSystemStore`, and `persistentFileSystem` restores it before the services exist; the example supplies `IndexedDB`. Persistence is tied to an explicit save rather than to autosave — a reload without one returns the seed. See "Making it survive a reload" above |

The one thing a page cannot do yet is **populate** a workspace — create, delete
or rename files. That gap is in the example app, not in the framework: a create
is an ordinary write and a delete an ordinary `deleteFile`, and a deletion of a
seeded path is stored as a tombstone rather than a dropped entry, so it survives
a reload instead of undoing itself. What is missing is a way for a user to ask
for it. Keeping the two apart matters — conflating them overstates what the
framework lacks and understates what the app does.

### The composition choice a page makes and a shell must not

With no TextMate grammar underneath it, the page sets `highlightKeywords` so the
server colours keywords too. A host that ships a grammar leaves that off:
semantic tokens override TextMate, and a grammar's keyword scopes are finer than
the flat `keyword` a legend carries.

The client is hand-written rather than built on `monaco-languageclient`, whose
shim stack would cost the bundle its `node:*` neutrality.

### Two obligations on a host that accepts `workspace/applyEdit`

**The framework gates the request on no client capability.** The egress checks
only that a `Connection` is bound, and `vscode-languageserver` forwards
unconditionally. So a host that sends `didOpen` and omits the handler has not
opted out — it answers `MethodNotFound` into a `window/logMessage` line and
loses the whole inbound direction in silence.

- **Refuse explicitly.** A host that will not apply an edit answers
  `applied: false` with a reason, rather than reporting success for an edit it
  dropped. The server's per-URI text shadow would otherwise diff every later
  push against a baseline the client never held.
- **Echo incrementally**, exactly as a conforming client does, and do not work
  around anything. `vscode-languageclient` echoes `didChange` with incremental
  ranges relative to its previous buffer, and the store reconstructs an incoming
  change against the pre-push text so an echo is recognised rather than
  re-applied. A host that switched to full-text echoes would be encoding a
  workaround into the one place adopters copy from.

## A note on what "gated neutral" does and does not promise

`check:neutral` bundles each gated entry for the browser and fails on a `node:*`
import. That is a real guarantee, and it has twice been a narrower one than it
looked. First, third-party deps were externalised so the check judged only each
package's own files, which left a portable entry importing a SIBLING's `/node`
subpath invisible to it.

`@hydranium/data-server` was doing exactly that — reaching `node:fs`, `node:v8`
and `node:perf_hooks` through `@hydranium/core/node` for its diagnostics methods
— while the gate reported it neutral. It was found by bundling the data head for
a browser for the first time, not by the gate. The gate now resolves
`@hydranium/*` instead of externalising it, so the cross-package case is covered.

Second — and this is the residue of the same decision — third-party deps are
still externalised, which is right (an unrelated package's Node code must not
decide our verdict) but means nothing reads inside them. A package's `/node`
subpath and a builtin spelled without the prefix therefore resolved cleanly and
would have failed only in a browser at runtime. The gate now classifies every
externalised specifier by NAME as well, with one importer-keyed exemption for the
bare `'path'` in accommodation 1.

Because both fixes are regression-only, the gate **self-tests**: three canary
fixtures must be rejected on every run, and it reports itself blind if one
survives. A clean run is then evidence rather than an absence.

The general lesson for an adopter: **your own browser bundle is the stricter
check.** It covers your whole composition, and a gate that scopes itself to one
package — or that stops reading at a specifier it externalises — cannot see what
happens at the seams.
