/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The client end of the worker's three channels, and the workbench that renders
 * what comes back: diagnostics from the LSP head, one document read through the
 * data head, a `.process` diagram from the GLSP head, and Monaco editors over the
 * same LSP channel the diagnostics arrive on.
 *
 * This module is the WIRING. What each area of the page is and how it behaves
 * lives beside it, one file per area — `workspace-panel.ts`, `editor-area.ts`,
 * `log-panel.ts`, `splitters.ts` — because the alternative in a hand-written page
 * is one file that grows a section per feature until nobody will touch it. The
 * page stays hand-written on purpose: its bundle is the strictest
 * browser-neutrality check the repo has, and a UI framework would remove the
 * property the package exists to demonstrate. See `dom.ts`.
 *
 * **Not the entry point, and the split is load-bearing rather than tidiness.**
 * `order-flow-page.ts` is, and it exists solely to put Monaco's own language in
 * place before this module — and therefore Monaco — is evaluated. Everything
 * from here down runs after that has happened, which is why {@link main} takes
 * the locale rather than reading it.
 *
 * # Reading the result
 *
 * The oracle is `hydranium-cli validate` over `examples/order-flow/workspace`,
 * which reports the same diagnostics from a Node process against the same
 * models. Matching counts mean the head genuinely ran; a shorter list here means
 * documents the workspace walk never reached, which is the failure this seeding
 * arrangement is most likely to produce.
 *
 * The page's editor text comes from the WORKER, which sends the workspace its
 * filesystem came up on once the heads are live. It is not read from the
 * generated seed here, and the difference matters as soon as anything has been
 * saved: the filesystem is the seed with the stored edits laid over it, while
 * `didOpen` is authoritative — so an editor opened on the committed bytes would
 * overwrite the restored document in the server's text store, undo the reload,
 * and change the diagnostics being compared against that oracle. Both failures
 * are silent.
 */

import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import {
   InitializedNotification,
   InitializeRequest,
   LogMessageNotification,
   type PublishDiagnosticsParams,
   PublishDiagnosticsNotification
} from 'vscode-languageserver-protocol';
import { DataEvents, DataSession, type TransferDocument } from '@hydranium/protocol';
import {
   type DomainModel,
   isLayoutModel,
   type LayoutModel,
   type ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import {
   BOOTSTRAP_MESSAGE_TYPE,
   isWorkerErrorMessage,
   isWorkspaceReadyMessage,
   isWorkspaceResetMessage,
   RESET_WORKSPACE_MESSAGE_TYPE,
   WORKSPACE_ROOT_URI,
   type WorkspaceReadyMessage
} from '../head-channels.js';
import { requireButton, requireCheckbox, requireElement, requireSelect } from './dom.js';
import { EditorArea } from './editor-area.js';
import { LogPanel } from './log-panel.js';
import { applyEditorScheme, type ColourScheme, MonacoLspAdapter } from './monaco-lsp-adapter.js';
import { applyPageLocale, localeUrl, PAGE_LOCALES } from './page-nls.js';
import { mountProcessDiagram } from './process-diagram.js';
import { wireLayoutReset, wireSplitters } from './splitters.js';
import { WorkspacePanel } from './workspace-panel.js';
import { WorkerDataPort } from './worker-data-port.js';

/** The union of transfer roots this workspace's three grammars produce. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/**
 * The worker bundle's path, substituted at build time from the same constant
 * that sets esbuild's `outfile`, so the two cannot drift.
 *
 * Derived rather than restated because the failure mode is silent: the URL
 * resolves against the DOCUMENT, not against this module, so a plausible-looking
 * relative path 404s — and the `ErrorEvent` a failed worker script raises
 * carries no message, filename or line number, leaving the page unable to tell a
 * missing file from a crash on the first statement.
 */
declare const __WORKER_BUNDLE_URL__: string;
const WORKER_URL = __WORKER_BUNDLE_URL__;

/**
 * How long to wait before saying that nothing is coming.
 *
 * Diagnostics arrive as notifications, so their absence is not observable by
 * waiting — a workspace that yielded no documents and a build still in progress
 * look identical, and the page would sit on `validating workspace…` forever.
 * Generous rather than tight: this reports a fact, it does not fail anything, so
 * a slow first build should not be able to trip it.
 */
const DIAGNOSTICS_DEADLINE_MS = 15_000;

/**
 * The document read back through the data head.
 *
 * The one with a deliberate error, chosen so the comparison against the LSP
 * head's diagnostics has something to compare — two heads agreeing that a
 * document is clean is satisfied by a head that never looked.
 */
const DATA_HEAD_DOCUMENT = `${WORKSPACE_ROOT_URI}/orders/audit-leak.domain`;

/**
 * The document the GLSP head renders.
 *
 * `.process` is the only grammar with a diagram — `.domain` is LSP-primary by
 * design — so the head asymmetry the example exists to show is also why there
 * is exactly one candidate kind of file here. This one has a layout beside it
 * (`fulfillment.layout`), so the nodes arrive with real bounds rather than
 * stacked at the origin, which is the difference between "a diagram rendered"
 * and "something is on the page".
 */
const GLSP_HEAD_DOCUMENT = `${WORKSPACE_ROOT_URI}/orders/fulfillment.process`;

/**
 * The layout secondary of {@link GLSP_HEAD_DOCUMENT}, watched through the data
 * head so a diagram edit is observable as a WRITE rather than as a redraw.
 *
 * Read through a different head than the one that wrote it, on purpose. The
 * diagram's own view of a moved node is the client's optimistic feedback, which
 * is drawn whether or not the operation ever reached the source model — so
 * measuring the write there would pass against a server that dropped it. This
 * document is the file the operation is supposed to change, and the data head
 * reads it out of the same Langium store the GLSP head wrote into.
 *
 * The values are the AST's, not the file's: a `ChangeBoundsOperation` goes
 * through `ModelService.update`, which rewrites the in-memory text document and
 * rebuilds. Nothing reaches the seeded filesystem until an explicit save.
 */
const LAYOUT_DOCUMENT = `${WORKSPACE_ROOT_URI}/orders/fulfillment.layout`;

/**
 * The two documents the diagram is a view of, both pinned under it.
 *
 * `.process` carries the semantics the canvas draws and `.layout` the coordinates
 * a drag rewrites, so the pair together is what shows a write landing in one file
 * and not the other — the page's central claim, visible without a click. Neither
 * may be displaced by a selection; see `editor-area.ts`.
 */
const FIXED_DOCUMENTS: readonly [string, string] = ['orders/fulfillment.process', 'orders/fulfillment.layout'];

/**
 * What the selection editor opens on.
 *
 * `orders.domain`, because it is the document `.process` reaches ACROSS a grammar
 * boundary into — `for Order`, and every `writes Order.status` — so the page opens
 * showing the reference chain's far end rather than an empty pane.
 *
 * Deliberately NOT `audit-leak.domain`, the one with a diagnostic: that document
 * has to stay closed for the problems list to be worth having, since the whole
 * point is a diagnostic published for a file nobody opened.
 *
 * Three documents of the workspace's eight, which also keeps the adapter's "no
 * model for this URI" branch on the normal path rather than leaving it an edge
 * case waiting to be discovered — most `publishDiagnostics` notifications still
 * address a document Monaco has never heard of.
 */
const INITIAL_SELECTION = 'orders/orders.domain';

const diagnosticsByUri = new Map<string, PublishDiagnosticsParams>();

/**
 * Whether `uri` is one of the seeded workspace's own documents.
 *
 * The distinction is load-bearing, not cosmetic. Documents also arrive from
 * in-code contributions on the `virtual:` scheme, which are registered
 * independently of the workspace folder and therefore publish even when the walk
 * found NOTHING — so "did any document validate" is not the same question as
 * "did the workspace load", and answering the first while meaning the second
 * reports a successful-looking count for an empty workspace. Measured: pointing
 * the walk at a folder with no files still validates one document.
 */
function isWorkspaceDocument(uri: string): boolean {
   return uri.startsWith(`${WORKSPACE_ROOT_URI}/`);
}

function setWorkspaceReport(text: string): void {
   const report = requireElement('workspace');
   report.textContent = text;
   // On the `title` too, because the strip truncates: the value here is the only
   // account of where the content came from, and a restore names its files.
   report.title = text;
}

function setStatus(text: string): void {
   requireElement('status').textContent = text;
}

/**
 * Fill the language switch and navigate when it changes.
 *
 * **A reload, and the reason is the SERVER half rather than this one.** The
 * page's own chrome could be re-translated in place — `applyPageLocale` walks
 * the document and rewrites text, so nothing about it needs a fresh load. The
 * language the language server renders in is declared once, at `initialize`, and
 * the worker holds that connection for its lifetime; there is no LSP
 * notification for "the user changed language", and re-initializing would mean
 * tearing down all three heads and the store they share. One switch drives both
 * halves, so it moves at the pace of the half that cannot change live.
 *
 * Which makes the reload honest rather than lazy: a reader who switches language
 * is told by the whole page at once, instead of getting German chrome around
 * English diagnostics.
 */
function wireLocaleSwitch(current: string | undefined): void {
   const control = requireSelect('page-locale');
   for (const locale of PAGE_LOCALES) {
      const option = document.createElement('option');
      // The code, or the empty string for the untranslated default — `value` is a
      // string slot, so the absent code cannot be represented as itself here.
      // `localeUrl` maps it back, which is why the mapping lives there.
      option.value = locale.code ?? '';
      option.textContent = locale.label;
      option.selected = locale.code === current;
      control.append(option);
   }
   control.addEventListener('change', () => {
      const chosen = PAGE_LOCALES.find(locale => (locale.code ?? '') === control.value);
      if (chosen !== undefined) {
         window.location.assign(localeUrl(window.location.href, chosen));
      }
   });
}

/**
 * Put the whole page into `scheme` — the page chrome, the diagram's
 * `--order-flow-*` colour roles, and every Monaco editor.
 *
 * **One function, three surfaces, and that is the design rather than
 * convenience.** The three are themed by different mechanisms — the chrome and
 * the roles by CSS keyed off this attribute, the editors by a Monaco API — and
 * three independent switches is how a page ends up half-switched, with a dark
 * editor in light chrome and a diagram that matches neither.
 *
 * The attribute goes on the root element because that is what the light role set
 * in `index.html` is scoped to. Writing it is the entire CSS half: `dark` means
 * no override, so the DARK values are the ones
 * `@hydranium/example-order-flow-client`'s own stylesheet declares — a shell that
 * supplies nothing still renders a legible diagram, and this page exercises that
 * by supplying only the light half.
 */
function applyScheme(scheme: ColourScheme): void {
   document.documentElement.dataset.theme = scheme;
   applyEditorScheme(scheme);
}

/**
 * The scheme to start in, and the switch that changes it.
 *
 * `prefers-color-scheme` for the initial value, per the OS, with the checkbox
 * able to overrule it afterwards — which is why the CSS keys off a `data-theme`
 * attribute rather than the media query directly: a query cannot be overridden
 * from script without restating every rule inside it.
 *
 * **The choice is deliberately NOT persisted**, unlike the workspace. The
 * workspace's store is asked for its content explicitly, at a point the page
 * controls; a remembered colour scheme would be read during startup, which makes
 * every spec depend on what the previous one left behind. Playwright gives each
 * test its own storage partition, so this is about a reader running the page by
 * hand as much as about the suite.
 */
function wireSchemeSwitch(): void {
   const control = requireCheckbox('dark-scheme');
   control.checked = window.matchMedia('(prefers-color-scheme: dark)').matches;
   control.addEventListener('change', () => applyScheme(control.checked ? 'dark' : 'light'));
   applyScheme(control.checked ? 'dark' : 'light');
}

/** Everything the page holds after bootstrap: one channel per head, plus the host protocol. */
interface WorkerChannels {
   readonly lsp: MessageConnection;
   readonly dataPort: MessagePort;
   readonly glspPort: MessagePort;
   /** The workspace the heads' filesystem came up on, once they are live. */
   readonly workspace: Promise<WorkspaceReadyMessage>;
   /** Ask the worker to forget every stored edit. The page reloads when it answers. */
   readonly resetWorkspace: () => void;
}

/**
 * Spawn the worker and hand each head its own channel. The worker keeps `port2`
 * of each pair; the page keeps `port1`.
 */
function bootstrapWorker(): WorkerChannels {
   const worker = new Worker(WORKER_URL);
   // Without this the page's only symptom for a worker that failed to load, or
   // threw on its first line, is a request that never settles — the same
   // appearance as a server still working. A worker has no visible console of
   // its own, so an unreported error here costs a debugging session.
   worker.addEventListener('error', event => {
      setStatus(`worker failed to start (${WORKER_URL}): ${event.message || 'no detail — check the script loaded'}`);
   });
   // The executor runs synchronously, so `announceWorkspace` is assigned before
   // the listener below can possibly fire.
   let announceWorkspace: (message: WorkspaceReadyMessage) => void = () => undefined;
   const workspace = new Promise<WorkspaceReadyMessage>(resolve => {
      announceWorkspace = resolve;
   });

   worker.addEventListener('message', event => {
      if (isWorkerErrorMessage(event.data)) {
         setStatus(`worker error during ${event.data.phase}: ${event.data.message}`);
         return;
      }
      if (isWorkspaceReadyMessage(event.data)) {
         announceWorkspace(event.data);
         return;
      }
      if (isWorkspaceResetMessage(event.data)) {
         // Reloaded rather than re-seeded in place: the worker dies with the
         // document, so the next load rebuilds every head over a store that is
         // now empty. Clearing the live filesystem instead would leave the
         // language server holding documents whose content it never re-read.
         location.reload();
      }
   });

   // One channel per head, transferred in a single message. Neither head is
   // given the worker global — see `head-channels.ts` for what happens if one
   // is, and note that the cost of the discipline is exactly this: one extra
   // `MessageChannel` and one more entry in the transfer list.
   const lsp = new MessageChannel();
   const data = new MessageChannel();
   const glsp = new MessageChannel();
   worker.postMessage({ type: BOOTSTRAP_MESSAGE_TYPE, ports: { lsp: lsp.port2, data: data.port2, glsp: glsp.port2 } }, [
      lsp.port2,
      data.port2,
      glsp.port2
   ]);
   return {
      lsp: createMessageConnection(new BrowserMessageReader(lsp.port1), new BrowserMessageWriter(lsp.port1)),
      dataPort: data.port1,
      glspPort: glsp.port1,
      workspace,
      resetWorkspace: () => worker.postMessage({ type: RESET_WORKSPACE_MESSAGE_TYPE })
   };
}

/** The data head's client end: one session, shared by every read and watch. */
interface DataHead {
   readonly session: DataSession<OrderFlowTransferRoot>;
   readonly events: DataEvents<OrderFlowTransferRoot>;
}

/**
 * One session for the whole page, not one per read.
 *
 * A second `DataSession` over the same port would be a second JSON-RPC
 * connection on it, and `BrowserMessageReader` assigns `port.onmessage` — so the
 * later reader silently replaces the earlier one and the first session's replies
 * stop arriving. Sharing is also what makes the echo filter mean anything: both
 * halves of this page write and watch under one `clientId`, so
 * `DataSession.isOwnEcho` can distinguish them from the GLSP head's writes.
 */
function openDataHead(dataPort: MessagePort): DataHead {
   const port = new WorkerDataPort('order-flow-browser-page', dataPort);
   const events = new DataEvents<OrderFlowTransferRoot>();
   return { session: new DataSession<OrderFlowTransferRoot>(port, events), events };
}

/**
 * One line describing what the data head says about a document: its root type
 * and how many diagnostics it currently carries.
 */
function describeDataDocument(document: TransferDocument<OrderFlowTransferRoot>): string {
   const root = document.root;
   const rootType = typeof root === 'object' && root !== null && '$type' in root ? String(root.$type) : 'unknown';
   return `root ${rootType}, ${document.diagnostics?.length ?? 0} diagnostic(s)`;
}

function setDataReport(document: TransferDocument<OrderFlowTransferRoot>): void {
   requireElement('data-head').textContent = describeDataDocument(document);
}

/**
 * Read one document through the DATA head and keep its report current.
 *
 * The point is the comparison, not the read: this document's diagnostics also
 * arrive over the LSP channel above, from the same Langium store in the same
 * worker. Agreement is the one-store-two-heads claim holding; disagreement
 * would mean the two heads are looking at different trees, which is the failure
 * mode that sharing a worker exists to prevent.
 *
 * **Which is why the line has to keep answering, not answer once.** The LSP
 * report is a notification handler and so corrects itself on every rebuild; a
 * data line written once diverges from it the moment anyone fixes the
 * diagnostic, and the pair then reads as the two heads disagreeing about the
 * store — the exact failure this comparison exists to detect, manufactured by
 * the client. A stale number is worse here than no number.
 *
 * The listener is registered BEFORE the open, for the reason
 * {@link watchLayoutThroughDataHead} gives: the open can itself trigger a
 * rebuild whose phase event lands while the promise is still in flight.
 */
async function watchThroughDataHead({ session, events }: DataHead): Promise<void> {
   events.onDidUpdateDocument(event => {
      if (event.document.uri === DATA_HEAD_DOCUMENT) {
         setDataReport(event.document);
      }
   });
   await session.openDocument(DATA_HEAD_DOCUMENT);
   // `openDocument` settles at the integrity landmark, so the diagnostics on
   // its snapshot are NOT GUARANTEED — and a client cannot tell which case it
   // got. A document the settle had to build arrives pre-validation with an
   // empty array; one that something else already carried to `Validated` comes
   // back carrying them, which is what this page produces, since the worker
   // validates the whole workspace before anything here opens a document. So
   // adopting the snapshot and never asking again reports whatever happened to
   // be there — and reports a clean document forever when that was nothing.
   // Asking explicitly is the documented way to get a validated one, and the
   // VS Code panel had this exact defect.
   //
   // Still needed with the watch in place, and not redundant with it: the
   // workspace build that validated this document may already have finished, in
   // which case no phase event is owed to a watcher registered afterwards and
   // the line would sit on the open snapshot's empty array until someone edited
   // the file.
   const server = await session.connected();
   setDataReport(await server.getModelDocument({ uri: DATA_HEAD_DOCUMENT, includeDiagnostics: true }));
}

/**
 * One line naming every positioned node in {@link LAYOUT_DOCUMENT}, in document
 * order.
 *
 * Document order rather than sorted, because it is what makes a CREATED entry
 * distinguishable from an updated one: both handlers append, so a node that had
 * no entry arrives last. `flowNode` is a `Reference`, which the transfer shape
 * carries as the reference TEXT — the name the `.layout` file actually spells,
 * not a resolved node.
 */
function describeLayout(root: LayoutModel): string {
   const entries = root.nodes.map(node => `${node.flowNode} ${node.x},${node.y}`);
   return `${entries.length} entries: ${entries.join('; ')}`;
}

function setLayoutReport(root: LayoutModel): void {
   const report = requireElement('layout-head');
   report.textContent = describeLayout(root);
   // The strip truncates, and this value grows by an entry on every create — so
   // the full text has to be reachable without resizing the window.
   report.title = report.textContent;
}

/**
 * Watch the layout secondary through the data head and keep its report current.
 *
 * The listener is registered BEFORE the open, not after. `openDocument` watches
 * as its second step, so a rebuild triggered by the open itself can deliver a
 * phase event while the returned promise is still in flight — and a listener
 * attached afterwards would miss it, leaving the report showing the open
 * snapshot with no later event guaranteed to correct it.
 */
async function watchLayoutThroughDataHead({ session, events }: DataHead): Promise<void> {
   events.onDidUpdateDocument(event => {
      if (event.document.uri === LAYOUT_DOCUMENT && isLayoutModel(event.document.root)) {
         setLayoutReport(event.document.root);
      }
   });
   const document = await session.openDocument(LAYOUT_DOCUMENT);
   if (isLayoutModel(document.root)) {
      setLayoutReport(document.root);
   }
}

/**
 * Persist every open editor's content through the DATA head.
 *
 * **A browser host has to ask for this explicitly, and the reason is a framework
 * fact rather than a browser one.** LSP puts the file write on the CLIENT — a
 * `textDocument/didSave` notification tells the server a save has happened, and
 * the framework answers it by firing `onDidSave`, not by writing anything. In
 * Theia or VS Code the shell does the writing; a page has no filesystem, so the
 * only end that can write is the worker, and `saveModelDocument` is the request
 * that makes it. Sending `didSave` here would persist nothing at all, silently.
 *
 * Which makes the parity with a Node host exact rather than approximate: an edit
 * lives in the in-memory text document until something saves it, on both ends.
 * A diagram drag reaches this buffer as a `workspace/applyEdit` first, so one
 * save covers both directions.
 *
 * Sequential, not concurrent: each save runs a serialize / apply / rebuild chain
 * over the shared store, and two of those interleaved would have the second
 * rebuild racing the first document's settle for no gain on two files.
 */
async function saveWorkspace(dataHead: DataHead, adapter: MonacoLspAdapter): Promise<void> {
   const documents = adapter.dirtyDocuments();
   if (documents.length === 0) {
      setWorkspaceReport('nothing to save');
      return;
   }
   setWorkspaceReport(`saving ${documents.length} document(s)…`);
   try {
      const server = await dataHead.session.connected();
      for (const document of documents) {
         await server.saveModelDocument({ uri: document.uri, clientId: dataHead.session.clientId, model: document.text });
         // Marked one at a time, so a failure part-way through leaves the
         // documents it never reached dirty and a second press retries exactly
         // those.
         adapter.markSaved(document);
      }
      setWorkspaceReport(`saved ${documents.length} document(s) — a reload restores them`);
   } catch (error: unknown) {
      // Reported rather than swallowed, because the store can genuinely refuse:
      // a quota is finite and the origin's storage may have been evicted. A page
      // that reported success here would lose the workspace on the next load
      // with nothing anywhere to say why.
      setWorkspaceReport(`save failed: ${error instanceof Error ? error.message : String(error)}`);
   }
}

/** Enable the save / reset controls, now that there is a head behind them. */
function wireWorkspaceControls(channels: WorkerChannels, dataHead: DataHead, adapter: MonacoLspAdapter): void {
   const save = requireButton('save-workspace');
   save.addEventListener('click', () => void saveWorkspace(dataHead, adapter));
   save.disabled = false;

   const reset = requireButton('reset-workspace');
   reset.addEventListener('click', () => {
      setWorkspaceReport('clearing stored edits…');
      channels.resetWorkspace();
   });
   reset.disabled = false;
}

/**
 * Build the page, in `locale`.
 *
 * The locale is HANDED IN rather than read here, because the entry has already
 * had to read it: Monaco captures its own language at import, so the choice is
 * made before this module exists. Reading `?locale=` a second time would let the
 * two disagree, which is the one failure the arrangement exists to rule out —
 * German chrome around English diagnostics reads as a broken catalogue rather
 * than as a client bug.
 */
export async function main(locale: string | undefined): Promise<void> {
   // Both switches before anything else, and for the same reason: the page must
   // not paint in one scheme or language and then flip. The editors read the
   // current scheme when they are created, the chrome's roles resolve as soon as
   // the attribute is set, and a label rewritten after the first paint is a
   // visible flash of the wrong language.
   applyPageLocale(locale);
   wireLocaleSwitch(locale);
   wireSchemeSwitch();
   const log = new LogPanel();
   setStatus('starting worker…');
   const channels = bootstrapWorker();
   const connection = channels.lsp;

   connection.onError(([error]) => setStatus(`connection error: ${error.message}`));
   connection.onClose(() => setStatus('connection closed by the worker'));

   // Registered BEFORE `listen`, and before `initialize` goes out, because this
   // is the earliest point at which a line can arrive and the lines from the
   // first workspace build are the ones worth having. A handler attached after
   // `initialize` resolves would miss the whole of server startup — the part a
   // reader most wants when the page does not come up.
   connection.onNotification(LogMessageNotification.type, params => log.append(params.type, params.message));

   connection.listen();

   setStatus(locale === undefined ? 'initializing…' : `initializing… (locale '${locale}')`);
   const initializeResult = await connection.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: WORKSPACE_ROOT_URI,
      // The reading user's language, which only the client knows. A worker has
      // no host to ask — no `vscode.env.language`, no Theia `localeId` — so the
      // page has to state it, and `initialize` is the same slot every other host
      // uses. Absent means the framework's English, which is correct rather than
      // a fallback: a page that declares no language has no user to have one.
      locale,
      // `applyEdit` declared because the adapter answers it, and for no stronger
      // reason than that it is true. **It does not gate the request, measured:**
      // `applyEditToLanguageClient` checks only that an LSP connection is bound
      // and `vscode-languageserver` forwards `workspace/applyEdit`
      // unconditionally, so a page that omits the declaration still receives the
      // request on every server-side write — and answers `MethodNotFound` to it
      // if it has no handler, which is a silent, total loss of the inbound
      // direction. The declaration documents the client; the HANDLER is what
      // makes the sync work.
      //
      // Everything else is left off rather than filled in optimistically. An
      // absent capability makes Langium fall back to a shape every client
      // understands, whereas claiming one this page does not implement produces
      // a response it cannot render.
      capabilities: { workspace: { applyEdit: true } },
      workspaceFolders: [{ uri: WORKSPACE_ROOT_URI, name: 'order-flow' }]
   });

   // The `initialize` RESULT is what the adapter needs, not the params: the
   // semantic-token legend is the index space the token stream is encoded in, so
   // it has to come from the server that encoded it.
   const adapter = new MonacoLspAdapter(connection, initializeResult.capabilities);

   // A HOLDER rather than a plain binding, because the two things that need it
   // cannot be ordered: the diagnostics handler has to be registered before
   // `initialized` or the first publishes are lost, and the sidebar cannot be
   // built until the worker has sent the workspace it came up on. So the handler
   // reads through this slot and does nothing until it is filled.
   const sidebar: { panel?: WorkspacePanel } = {};

   // ONE handler for the notification, fanning out to all three consumers. A
   // second `onNotification` for the same method would silently REPLACE this one
   // — `MessageConnection` keys its handlers by method and still returns a
   // disposable — so the adapter and the sidebar take the params from here rather
   // than subscribing for themselves.
   //
   // Registered in the window BETWEEN `initialize` and `initialized`, which is
   // the only place it can be and still be both complete and after the adapter
   // exists: the server publishes nothing before `initialized`, so nothing can
   // be missed, while registering earlier would mean holding the adapter in a
   // mutable slot the handler reads through.
   connection.onNotification(PublishDiagnosticsNotification.type, params => {
      diagnosticsByUri.set(params.uri, params);
      const total = [...diagnosticsByUri.values()].reduce((sum, entry) => sum + entry.diagnostics.length, 0);
      setStatus(`${diagnosticsByUri.size} documents validated, ${total} diagnostics`);
      sidebar.panel?.render(diagnosticsByUri);
      adapter.applyDiagnostics(params);
   });

   connection.sendNotification(InitializedNotification.type, {});

   // The editors wait for the worker's workspace, which is the only place their
   // text can honestly come from once a stored edit may be laid over the seed.
   // Awaited AFTER `initialized` because a `didOpen` is a client statement about
   // a document and the server is not obliged to answer one before then — and
   // the LSP handshake above needs no content, so the wait costs nothing it did
   // not already cost.
   const ready = await channels.workspace;
   setWorkspaceReport(
      ready.restored.length === 0
         ? 'no stored edits — seeded from the committed workspace'
         : `restored ${ready.restored.length} file(s) from storage: ${[...ready.restored].sort().join(', ')}`
   );

   const editors = new EditorArea({
      adapter,
      files: ready.files,
      rootUri: WORKSPACE_ROOT_URI,
      fixed: FIXED_DOCUMENTS,
      initialSelection: INITIAL_SELECTION,
      onVisibleChanged: visible => {
         sidebar.panel?.setVisible(visible);
         sidebar.panel?.render(diagnosticsByUri);
      }
   });

   sidebar.panel = new WorkspacePanel(Object.keys(ready.files), WORKSPACE_ROOT_URI, {
      onOpenDocument: path => editors.show(path),
      onOpenDiagnostic: target => editors.reveal(target.uri.slice(WORKSPACE_ROOT_URI.length + 1), target.line),
      // A `virtual:` document has no file behind it, so there is nothing to open
      // and saying so is the honest answer — the alternative is a click that does
      // nothing, which reads as a broken list.
      onUnopenable: uri => setWorkspaceReport(`${uri} has no file behind it — an in-code contribution cannot be opened`)
   });
   sidebar.panel.setVisible(editors.visible());
   sidebar.panel.render(diagnosticsByUri);

   // The dividers, and the two things that have to be told when one moves: Monaco
   // measures its container, and sprotty caches its canvas bounds.
   const relayout = (): void => editors.layout();
   wireSplitters(relayout);
   wireLayoutReset(relayout);

   setStatus('validating workspace…');

   setTimeout(() => {
      if (![...diagnosticsByUri.keys()].some(isWorkspaceDocument)) {
         setStatus(
            `no workspace document validated after ${DIAGNOSTICS_DEADLINE_MS / 1000}s — the walk found nothing ` +
               'under the seeded root, or the build never reached validation'
         );
      }
   }, DIAGNOSTICS_DEADLINE_MS);

   const dataHead = openDataHead(channels.dataPort);
   await watchThroughDataHead(dataHead);

   // Enabled here, after the data head has answered once: the save goes through
   // it, so a control armed before that could only fail.
   wireWorkspaceControls(channels, dataHead, adapter);

   // Before the diagram, so the layout report is already live when the first
   // edit lands. Opening it after mounting would leave the window between the
   // two unobserved — an edit made in it would be visible only as whatever the
   // subsequent open happened to read, which is a snapshot rather than a write.
   await watchLayoutThroughDataHead(dataHead);

   // After the data head and not beside it, because the two reports are read
   // against each other and a failure in either should not be attributed to the
   // other's timing. Its own try/catch for the same reason: a diagram that
   // cannot load must not take the diagnostics report down with it — the LSP
   // head's answer is the older claim and stands on its own.
   const setGlspReport = (report: string): void => {
      requireElement('glsp-head').textContent = report;
   };
   setGlspReport('loading…');
   try {
      // The callback keeps the line current as elements are created and deleted;
      // the resolved value is the first reading. A report written once would go
      // stale on the first palette gesture, beside a layout report that does not.
      setGlspReport(await mountProcessDiagram(channels.glspPort, GLSP_HEAD_DOCUMENT, setGlspReport));
   } catch (error: unknown) {
      requireElement('glsp-head').textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
   }

   // The diagnostics report does NOT depend on the editors above. Langium
   // publishes for every document the workspace walk builds, so all eight are
   // counted whether or not any is open — which is why the report can be
   // compared against a Node oracle that opens nothing at all.
}
