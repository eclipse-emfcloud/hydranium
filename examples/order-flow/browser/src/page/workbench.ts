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
   PublishDiagnosticsNotification,
   RegistrationRequest,
   UnregistrationRequest
} from 'vscode-languageserver-protocol';
import {
   DataConnectionWithEvents,
   type DataServerDiagnosticsProtocol,
   type DataServerProtocol,
   type DataSession,
   formatLatencyReport,
   type LatencyReport,
   type TransferDocument
} from '@hydranium/protocol';
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
import { requireButton, requireCheckbox, requireDialog, requireElement } from './dom.js';
import { EditorArea } from './editor-area.js';
import { wireLogLevelControl, wireTraceControl } from './log-controls.js';
import { LogPanel } from './log-panel.js';
import { applyEditorScheme, type ColourScheme, MonacoLspAdapter } from './monaco-lsp-adapter.js';
import { applyPageLocale, localeUrl, type PageLocale, PAGE_LOCALES, rememberLocale } from './page-nls.js';
import { rememberPreference, storedPreference } from './preferences.js';
import { mountProcessDiagram, PROCESS_DIAGRAM_ELEMENT_ID } from './process-diagram.js';
import { PROPERTIES_CLIENT_ID, PropertiesPanel } from './properties-panel.js';
import { publishReport, ReportDetail } from './report-detail.js';
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
   publishReport('workspace', text);
}

function setStatus(text: string): void {
   publishReport('status', text);
}

/**
 * The documents the server is holding edits for that nothing has persisted.
 *
 * A holder rather than a parameter because its readers are wired at opposite
 * ends of startup: the language switch and the unload guard are both in place
 * before there is a head for anything to be dirty against, and have to keep
 * answering while the truthful answer is "none".
 */
let unsavedDocuments: () => readonly string[] = () => [];

/**
 * Whether the navigation about to happen is one the reader confirmed.
 *
 * Without it the two guards fire on the same navigation: the language switch
 * asks, the reader agrees, and the unload handler then asks again in the
 * browser's own words for the reload the reader just authorised.
 */
let navigationConfirmed = false;

/** Persist every dirty document, exposed for the guards that offer saving. */
let saveEverything: () => Promise<void> = async () => undefined;

/**
 * Ask what to do about `unsaved` before a reload drops it.
 *
 * Every non-button dismissal resolves to `cancel`: proceeding on a non-answer
 * is the failure this exists to prevent.
 */
async function askAboutUnsaved(unsaved: readonly string[]): Promise<'cancel' | 'discard' | 'save'> {
   const dialog = requireDialog('language-dialog');
   requireElement('language-dialog-documents').textContent = unsaved.map(uri => uri.slice(WORKSPACE_ROOT_URI.length + 1)).join(', ');
   dialog.returnValue = 'cancel';
   dialog.showModal();
   await new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
   return dialog.returnValue === 'save' ? 'save' : dialog.returnValue === 'discard' ? 'discard' : 'cancel';
}

/** Ask before discarding the stored workspace, which nothing can undo. */
async function confirmReset(): Promise<boolean> {
   const dialog = requireDialog('reset-dialog');
   dialog.returnValue = 'cancel';
   dialog.showModal();
   await new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
   return dialog.returnValue === 'confirm';
}

/**
 * Refuse a reload that would drop unsaved edits.
 *
 * The browser supplies the wording and ignores ours, so this only decides
 * WHETHER to ask. `returnValue` is set as well as `preventDefault` because the
 * older spelling is still what some browsers consult.
 */
function wireUnloadGuard(): void {
   window.addEventListener('beforeunload', event => {
      if (navigationConfirmed || unsavedDocuments().length === 0) {
         return;
      }
      event.preventDefault();
      event.returnValue = '';
   });
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
   const control = requireElement('page-locale');
   for (const locale of PAGE_LOCALES) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'locale-option';
      // The code, or the empty string for the untranslated default — a dataset
      // slot is a string, so the absent code cannot be represented as itself
      // here. `localeUrl` maps it back, which is why the mapping lives there.
      option.dataset.locale = locale.code ?? '';
      option.textContent = locale.label;
      option.setAttribute('aria-pressed', String(locale.code === current));
      option.addEventListener('click', () => {
         if (locale.code === current) {
            return;
         }
         void switchLocale(locale);
      });
      control.append(option);
   }
}

/**
 * Switch to `locale`, asking first when the reload would drop unsaved work.
 *
 * Conditional, and that is what keeps it a guard: one that fires on every
 * switch is one a reader learns to dismiss unread. The unload guard is disarmed
 * just before navigating, or both would ask.
 */
async function switchLocale(locale: PageLocale): Promise<void> {
   const unsaved = unsavedDocuments();
   if (unsaved.length > 0) {
      const answer = await askAboutUnsaved(unsaved);
      if (answer === 'cancel') {
         return;
      }
      if (answer === 'save') {
         await saveEverything();
      }
   }
   // Stored BEFORE the navigation, because the navigation is what ends this
   // document — anything queued after it is not guaranteed to run.
   rememberLocale(locale);
   navigationConfirmed = true;
   window.location.assign(localeUrl(window.location.href, locale));
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
/**
 * Mark the pane holding the focus. The caret cannot say: a diagram has none,
 * and an editor that lost focus goes on drawing the one it had.
 *
 * On the DOCUMENT, because the log, problems and status bar sit outside the
 * layout — a listener scoped to the panes cannot see focus leave for one of
 * those. `focusin` bubbles where `focus` does not, and sprotty replaces its
 * focusable element on every model update.
 */
function wireActivePane(): void {
   const layout = requireElement('layout');
   document.addEventListener('focusin', event => {
      const active = event.target instanceof Element ? event.target.closest('.pane') : null;
      layout.querySelectorAll('.pane').forEach(pane => pane.classList.toggle('is-active', pane === active));
   });
}

function applyScheme(scheme: ColourScheme): void {
   document.documentElement.dataset.theme = scheme;
   applyEditorScheme(scheme);
}

/**
 * The scheme to start in: `?theme=` on the URL, then what the last visit stored,
 * then `prefers-color-scheme`.
 *
 * The CSS keys off `data-theme` rather than the media query, which script
 * cannot override without restating every rule inside it.
 *
 * `?theme=` is CLEARED once the switch disagrees: it outranks the store and the
 * language switch carries it across a reload, so leaving it would undo the
 * reader's choice.
 */
function schemeToStartIn(): ColourScheme {
   const requested = new URLSearchParams(window.location.search).get('theme')?.trim();
   if (requested === 'dark' || requested === 'light') {
      return requested;
   }
   const stored = storedPreference('scheme');
   if (stored === 'dark' || stored === 'light') {
      return stored;
   }
   return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The scheme to start in, and the switch that changes and remembers it.
 *
 * Only the SWITCH stores: seeding would freeze whatever the OS said on a first
 * visit and stop the page following it thereafter.
 */
function wireSchemeSwitch(): void {
   const control = requireCheckbox('dark-scheme');
   const apply = (scheme: ColourScheme): void => {
      control.checked = scheme === 'dark';
      applyScheme(scheme);
      rememberPreference('scheme', scheme);
      // `replaceState` rather than a navigation: the scheme changed in place and
      // nothing here needs reloading, so this only stops the address bar naming
      // a scheme the page has stopped obeying.
      const url = new URL(window.location.href);
      if (url.searchParams.has('theme')) {
         url.searchParams.delete('theme');
         window.history.replaceState(null, '', url);
      }
   };
   control.addEventListener('change', () => apply(control.checked ? 'dark' : 'light'));
   const initial = schemeToStartIn();
   control.checked = initial === 'dark';
   applyScheme(initial);
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

/**
 * What this page asks of the data server: the document protocol plus the
 * diagnostics one.
 *
 * Named rather than taken from `DataConnection`'s default, which covers the
 * document methods alone — `getLatency` lives on the diagnostics protocol, and a
 * connection left at the default types a call to it as an error.
 */
type OrderFlowDataServer = DataServerProtocol<OrderFlowTransferRoot> & DataServerDiagnosticsProtocol;

/**
 * The page's own participant, alongside whatever else takes a session.
 *
 * This and `PROPERTIES_CLIENT_ID` are two participants on ONE connection, and
 * they are two different strings on purpose: an id names a participant rather
 * than a wire, so sharing one would collapse both onto a single hold and make
 * each read the other's writes as its own echo. `createSession` throws on the
 * second rather than letting either happen quietly.
 */
const PAGE_CLIENT_ID = 'order-flow-browser-page';

/**
 * One connection for the whole page, not one per read.
 *
 * A second connection over the same port would be a second JSON-RPC connection
 * on it, and `BrowserMessageReader` assigns `port.onmessage` — so the later
 * reader silently replaces the earlier one and the first connection's replies
 * stop arriving. A second interested party takes a second session off this one
 * instead, which costs no transport and keeps the echo filter meaningful: two
 * parties sharing one `clientId` read each other's writes as their own echoes
 * and ignore them.
 */
function openDataHead(dataPort: MessagePort): DataHead {
   const connection = new DataConnectionWithEvents<OrderFlowTransferRoot, OrderFlowDataServer>(new WorkerDataPort(dataPort));
   return { connection, session: connection.createSession(PAGE_CLIENT_ID) };
}

/** The connection plus the page's own session on it. */
interface DataHead {
   readonly connection: DataConnectionWithEvents<OrderFlowTransferRoot, OrderFlowDataServer>;
   readonly session: DataSession<OrderFlowTransferRoot, OrderFlowDataServer>;
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
   publishReport('data-head', describeDataDocument(document));
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
async function watchThroughDataHead({ session, connection }: DataHead): Promise<void> {
   connection.events.onDidUpdateDocument(event => {
      if (event.document.uri === DATA_HEAD_DOCUMENT) {
         setDataReport(event.document);
      }
   });
   await session.openDocument({ uri: DATA_HEAD_DOCUMENT });
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
   publishReport('layout-head', describeLayout(root));
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
async function watchLayoutThroughDataHead({ session, connection }: DataHead): Promise<void> {
   connection.events.onDidUpdateDocument(event => {
      if (event.document.uri === LAYOUT_DOCUMENT && isLayoutModel(event.document.root)) {
         setLayoutReport(event.document.root);
      }
   });
   const document = await session.openDocument({ uri: LAYOUT_DOCUMENT });
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
async function saveWorkspace(dataHead: DataHead, adapter: MonacoLspAdapter, editors: EditorArea, only?: string): Promise<void> {
   // Filtered from the same dirty set the button uses rather than read another
   // way, so "what Ctrl+S writes" and "what Save workspace writes" can never
   // disagree about whether a document had changed.
   const documents = adapter.dirtyDocuments().filter(document => only === undefined || document.uri === only);
   if (documents.length === 0) {
      setWorkspaceReport('nothing to save');
      return;
   }
   setWorkspaceReport(`saving ${documents.length} document(s)…`);
   try {
      for (const document of documents) {
         await dataHead.session.saveDocument({ uri: document.uri, model: document.text });
         // Marked one at a time, so a failure part-way through leaves the
         // documents it never reached dirty and a second press retries exactly
         // those.
         adapter.markSaved(document);
      }
      editors.refreshDirtyMarks();
      setWorkspaceReport(`saved ${documents.length} document(s) — a reload restores them`);
   } catch (error: unknown) {
      // Reported rather than swallowed, because the store can genuinely refuse:
      // a quota is finite and the origin's storage may have been evicted. A page
      // that reported success here would lose the workspace on the next load
      // with nothing anywhere to say why.
      setWorkspaceReport(`save failed: ${error instanceof Error ? error.message : String(error)}`);
   }
}

/** The strip's one line: how wide the window is, and how much answered in it. */
function summariseLatency(report: LatencyReport): string {
   if (report.methods.length === 0) {
      return 'no calls timed yet';
   }
   return `${report.methods.length} method(s) over ${(report.windowMs / 1000).toFixed(1)}s`;
}

/**
 * Let the Latency category read the data head when it is opened.
 *
 * The only category that ASKS rather than being published, which is why it needs
 * a provider at all. The read happens on the opening click alone: `getLatency`
 * is itself a timed call, so a refresh while the region is open — or on a timer
 * — would grow the report by an entry that exists only because someone was
 * reading it.
 */
function provideLatency(dataHead: DataHead, detail: ReportDetail): void {
   detail.provide('latency', async () => {
      const server = await dataHead.session.connected();
      const report = await server.getLatency();
      publishReport('latency', summariseLatency(report));
      return formatLatencyReport(report);
   });
}

/**
 * Save on `Ctrl+S` / `Cmd+S`, scoped to whatever the reader is in.
 *
 * An editor saves ITS document and the properties panel saves the one it is
 * showing; anywhere else saves everything, which is what the toolbar button has
 * always done. Two scopes because the shortcut means "persist what I am working
 * on" and a page with three editors open has to answer which one that is.
 *
 * ONE document-level listener rather than a command registered per editor:
 * measured, Monaco neither binds nor swallows this chord, so the same handler
 * serves the editors, the panel and the rest of the page — and the three cases
 * are decided in one place instead of diverging across three registrations.
 *
 * `preventDefault` is the whole of the browser accommodation: without it the
 * chord also opens the native Save-Page dialog.
 */
function wireSaveShortcut(save: (only?: string) => void, editors: EditorArea, properties: { panel?: PropertiesPanel }): void {
   document.addEventListener(
      'keydown',
      event => {
         if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey) || event.altKey) {
            return;
         }
         event.preventDefault();
         const focused = editors.focusedPath();
         if (focused !== undefined) {
            save(`${WORKSPACE_ROOT_URI}/${focused}`);
            return;
         }
         const inPanel = event.target instanceof Element && event.target.closest('#properties-body') !== null;
         save(inPanel ? properties.panel?.documentUri : undefined);
      },
      true
   );
}

/** Enable the save / reset controls, now that there is a head behind them. */
function wireWorkspaceControls(channels: WorkerChannels, dataHead: DataHead, adapter: MonacoLspAdapter, editors: EditorArea): void {
   const save = requireButton('save-workspace');
   save.addEventListener('click', () => void saveWorkspace(dataHead, adapter, editors));
   save.disabled = false;
   // Published for the guards, which offer saving as the answer to a navigation
   // that would otherwise drop the work.
   saveEverything = () => saveWorkspace(dataHead, adapter, editors);

   const reset = requireButton('reset-workspace');
   reset.addEventListener('click', () => {
      // Asked UNCONDITIONALLY, unlike the language switch's. That one guards
      // against losing edits and has nothing to say when there are none; this
      // one discards the store itself, which is destructive whatever the editors
      // hold and cannot be undone from the page.
      void confirmReset().then(confirmed => {
         if (!confirmed) {
            return;
         }
         setWorkspaceReport('clearing stored edits…');
         channels.resetWorkspace();
      });
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
   wireUnloadGuard();
   wireActivePane();
   // Before anything publishes into the strip: the categories carry a placeholder
   // until their head answers, and a label that does nothing until then reads as
   // a dead control rather than as a value not yet in.
   const reportDetail = new ReportDetail();
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

   // Acknowledge dynamic registrations: declaring `workspace.configuration` makes
   // the server register for the sections it watches, and an unanswered request
   // surfaces as a page error. Nothing is kept — the page pushes its own
   // section's changes whether or not anything registered for them.
   connection.onRequest(RegistrationRequest.type, () => undefined);
   connection.onRequest(UnregistrationRequest.type, () => undefined);

   // Before `listen`, and the level control also before `initialize`: the server
   // reads its configuration section while the workspace comes up, and an
   // unanswered request there reads as a client with no settings.
   wireLogLevelControl(connection);
   wireTraceControl(connection, log);

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
      // `configuration` DOES gate its request, unlike `applyEdit` above: the
      // provider reads the declaration at `initialize` and, absent it, asks for
      // no section ever, so the log-level picker would reach nothing.
      capabilities: { workspace: { applyEdit: true, configuration: true } },
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
   // Same deferred slot as `sidebar.panel`, for the same ordering: the editors
   // are built from the worker's workspace, and the properties panel needs a
   // data-head session, which is opened after them. A focus that lands before
   // the panel exists is dropped, and the panel opens on the focused document
   // once it is wired.
   const properties: { panel?: PropertiesPanel } = {};

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
      },
      onFocusChanged: path => properties.panel?.showDocument(`${WORKSPACE_ROOT_URI}/${path}`),
      onDirtyChanged: dirty => {
         unsavedDocuments = () => [...dirty];
         sidebar.panel?.setDirty(dirty);
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
   wireWorkspaceControls(channels, dataHead, adapter, editors);
   wireSaveShortcut(only => void saveWorkspace(dataHead, adapter, editors, only), editors, properties);
   provideLatency(dataHead, reportDetail);

   // The SECOND participant on the one connection, and the reason the page needs
   // sessions at all: it holds its own documents open and reads its own writes
   // back as echoes rather than as foreign edits.
   properties.panel = new PropertiesPanel(dataHead.connection.createSession(PROPERTIES_CLIENT_ID), dataHead.connection.events);

   // The panel's first document is established by FOCUSING one, not by opening
   // it directly: an initial document chosen here would be a second answer to
   // "which document is shown", and whichever of the two landed last would win.
   // `show` focuses and announces through the one path every later change takes.
   //
   // The process document because it is the one with editable fields — a
   // `.domain` root has none — and because it is what the diagram and both
   // pinned editors are already about.
   editors.show(FIXED_DOCUMENTS[0]);

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
   const setGlspReport = (report: string): void => publishReport('glsp-head', report);
   setGlspReport('loading…');
   try {
      // The callback keeps the line current as elements are created and deleted;
      // the resolved value is the first reading. A report written once would go
      // stale on the first palette gesture, beside a layout report that does not.
      setGlspReport(await mountProcessDiagram(channels.glspPort, GLSP_HEAD_DOCUMENT, setGlspReport));
      // AFTER the mount, and the ordering is the whole of it: a listener put on
      // this element before the diagram takes it over never fires — measured,
      // the same registration moved above this line stops working.
      //
      // The diagram is a view of the process document and has to announce that
      // itself, being no Monaco editor and so raising no editor focus — without
      // this the panel stays on whatever was focused before, which reads as
      // having stopped following. `pointerdown` in the CAPTURE phase, because
      // the canvas takes DOM focus on some gestures and not others, and its own
      // mouse handling stops the event on the way back up.
      requireElement(PROCESS_DIAGRAM_ELEMENT_ID).addEventListener(
         'pointerdown',
         () => properties.panel?.showDocument(GLSP_HEAD_DOCUMENT),
         true
      );
   } catch (error: unknown) {
      setGlspReport(`failed: ${error instanceof Error ? error.message : String(error)}`);
   }

   // The diagnostics report does NOT depend on the editors above. Langium
   // publishes for every document the workspace walk builds, so all eight are
   // counted whether or not any is open — which is why the report can be
   // compared against a Node oracle that opens nothing at all.
}
