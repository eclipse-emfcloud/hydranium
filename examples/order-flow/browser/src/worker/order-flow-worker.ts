/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The order-flow heads, hosted in a web worker with no Node runtime.
 *
 * The counterpart to `order-flow-server`'s `main.ts`, which composes the same
 * language against a Node connection and a disk. The two ends differ — the
 * transport and the filesystem — and that is the claim this host exists to
 * check: everything between them is the same composition.
 *
 * **The filesystem is persistent, which makes the parity with the Node entry
 * closer than it looks.** Reads are served from a map, because Langium's
 * provider requires synchronous ones and no browser store offers them; writes
 * mirror into `IndexedDB` and the next start is restored from it. So a save
 * outlives the page exactly as a save outlives the Node process, and the
 * unsaved-edit story is the same on both ends: a diagram drag or a keystroke
 * lives in the in-memory text document until something saves it.
 *
 * **One option differs too, and it is not a transport concern:**
 * `highlightKeywords`. The VS Code and Theia hosts ship `.tmLanguage.json`
 * grammars that already colour keywords, with finer scopes than the flat
 * `keyword` a semantic token carries — and semantic tokens override TextMate,
 * so enabling it there would make their editors less coloured. This page ships
 * no client-side grammar at all, deliberately, because "the colours come from
 * the server" is the property it exists to demonstrate. Without the option the
 * demonstration is half-made: names are coloured and every keyword renders in
 * the default foreground.
 *
 * Heads bind the ports handed to them at bootstrap and never the worker global.
 */

// FIRST, before any module carrying an Inversify decorator is evaluated. GLSP's
// server is decorator-driven throughout, and `emitDecoratorMetadata` output
// reads `Reflect.getMetadata` at class-definition time — so a late import gives
// a container that resolves nothing, with errors naming the injected parameter
// rather than the missing polyfill.
import 'reflect-metadata';
import { ServerModule } from '@eclipse-glsp/server/browser.js';
import { persistentFileSystem } from '@hydranium/core';
import { DataServer } from '@hydranium/data-server';
import { createOrderFlowServices, type OrderFlowSharedServices } from '@hydranium/example-order-flow-server';
import { OrderFlowProcessDiagramModule } from '@hydranium/example-order-flow-server/lib/glsp/order-flow-process-diagram-module';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import { startLanguageServer } from '@hydranium/langium/lsp';
import { URI } from '@hydranium/langium';
import { createMessageConnection } from 'vscode-jsonrpc/browser';
import { BrowserMessageReader, BrowserMessageWriter, createConnection, ProposedFeatures } from 'vscode-languageserver/browser';
import { ORDER_FLOW_WORKSPACE_SEED } from '../generated/workspace-seed.js';
import {
   type BootstrapMessage,
   formatError,
   isBootstrapMessage,
   isResetWorkspaceMessage,
   WORKER_ERROR_MESSAGE_TYPE,
   WORKSPACE_READY_MESSAGE_TYPE,
   WORKSPACE_RESET_MESSAGE_TYPE,
   WORKSPACE_ROOT_URI,
   type WorkspaceFiles
} from '../head-channels.js';
import { IndexedDbFileSystemStore } from '../workspace/indexeddb-file-system-store.js';

/**
 * Report a failure to the page on the global channel — the one no head is
 * allowed to bind, which is what keeps it available for this.
 */
function reportError(phase: string, error: unknown): void {
   postMessage({ type: WORKER_ERROR_MESSAGE_TYPE, phase, message: formatError(error) });
}

// Both handlers exist because the interesting failures here are asynchronous and
// unowned. An LSP notification handler that rejects — which is how the workspace
// walk runs — produces an unhandled rejection and nothing else: no reply to
// reject, no request to fail, and a page that waits forever on diagnostics that
// were never going to arrive.
addEventListener('error', event => reportError('worker', event.message));
addEventListener('unhandledrejection', event => reportError('unhandled rejection', event.reason));

/**
 * Compose the language on the LSP port and return the shared tier the other
 * heads attach to.
 *
 * The services are built around the LSP connection, exactly as the Node entry
 * builds them around a stdio one — which is why this function, and not the
 * bootstrap handler, owns their creation.
 */
function startLspHead(port: MessagePort, fileSystem: WorkspaceFileSystem): OrderFlowSharedServices {
   // `BrowserMessageReader` assigns `port.onmessage`, which starts a
   // `MessagePort` implicitly — so no `port.start()` here. Adding one is
   // harmless; omitting it would be fatal only if the reader had used
   // `addEventListener` instead, which is the more common spelling and the
   // reason this is worth stating rather than leaving to be re-derived.
   //
   // **The filesystem is handed in ALREADY RESTORED, and that ordering is not
   // stylistic.** The reader starts its port as it is constructed but drops
   // every message until `startLanguageServer` calls `listen`, so an `await`
   // between these two statements loses the `initialize` the page has already
   // sent — no error, no reply, a page that waits forever. Everything
   // asynchronous therefore happens before this function is called.
   const connection = createConnection(ProposedFeatures.all, new BrowserMessageReader(port), new BrowserMessageWriter(port));
   const { shared } = createOrderFlowServices(
      { connection, ...fileSystem },
      // The one option this host sets, for the reason in the module doc: no
      // client-side grammar means the server is the only source of colour.
      { highlightKeywords: true }
   );
   startLanguageServer(shared);
   return shared;
}

/**
 * Attach the data head to the SAME shared tier, on its own port.
 *
 * One store, two heads — the property the whole arrangement exists to
 * demonstrate, and the reason both heads must live in one worker rather than
 * one worker each.
 *
 * `listen()` comes after the server is constructed, matching the order the
 * socket launcher uses on Node: the `DataServer` binds its request handlers in
 * its constructor, and a connection that is already listening can deliver a
 * message before they exist.
 */
function startDataHead(port: MessagePort, shared: OrderFlowSharedServices): void {
   const connection = createMessageConnection(new BrowserMessageReader(port), new BrowserMessageWriter(port));
   new DataServer<OrderFlowTransferRoot>(connection, shared);
   connection.listen();
}

/**
 * Attach the GLSP head to the same shared tier, on the third port.
 *
 * The composition is `order-flow-server`'s, unmodified: the same
 * {@link OrderFlowProcessDiagramModule} the Node entry configures, the same
 * unsubclassed {@link HydraniumGlspAppModule}. Only the bringup differs —
 * `startGlspServerInWorker` in place of `startGlspServer` — which is the claim
 * this head is here to make.
 *
 * The logger goes through the LSP connection like the Node entry's, for a
 * different reason: there is no stdout to corrupt here, but a worker's console
 * is a place nobody is looking, and the LSP channel already reaches the page.
 */
function startGlspHead(port: MessagePort, shared: OrderFlowSharedServices): void {
   startGlspServerInWorker({
      context: port,
      // No `logLevel`: the logger tracks the framework threshold, which in a
      // browser has no `HYDRANIUM_LOG_LEVEL` to read and so sits at its `'info'`
      // default until something calls `Logger.setLevel`.
      createLogger: caller => new GlspClientLogger(shared, { component: caller }),
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      appModules: [new HydraniumGlspAppModule({ shared })]
   });
}

/**
 * Build every registered document to `Validated`, once workspace startup has
 * settled.
 *
 * **The initial workspace build does not validate**, by Langium's design:
 * `initializeWorkspace` builds with `initialBuildOptions`, whose `validation` is
 * unset, so every document stops at `IndexedReferences` with no diagnostics
 * computed and none published. A client that only opens a socket and waits
 * therefore sees a server that started correctly, indexed the workspace, and
 * says nothing — indistinguishable from an empty workspace.
 *
 * Asking for the validating build is the host's job, and it is the same trailing
 * `build(..., { validation: true })` that `buildWorkspaceProgrammatically` runs
 * for the headless tools. Diagnostics follow from the `Validated` document phase
 * that Langium's own LSP wiring publishes on.
 *
 * `workspaceInitialized` is the documented gate for "startup has settled";
 * building before it would race the walk and validate a partial document set.
 */
async function validateWholeWorkspace(shared: OrderFlowSharedServices): Promise<void> {
   await shared.workspace.WorkspaceManager.workspaceInitialized;
   await shared.workspace.DocumentBuilder.build(shared.workspace.LangiumDocuments.all.toArray(), { validation: true });
}

/** The union of transfer roots this workspace's three grammars produce. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/** The DI fragment {@link persistentFileSystem} binds, named so the head takes it as one thing. */
type WorkspaceFileSystem = Awaited<ReturnType<typeof persistentFileSystem>>;

/**
 * The store every head persists through, and the one a page reset clears.
 *
 * Module-level rather than per-bootstrap: the reset message can arrive before or
 * after the heads exist, and a store held inside the bootstrap closure would be
 * unreachable from the message handler.
 */
const workspaceStore = new IndexedDbFileSystemStore();

/**
 * Every file the heads came up on, read out of the FILESYSTEM rather than out of
 * the generated seed.
 *
 * The two differ the moment anything has been saved, and the seed is the wrong
 * one: the page opens editors on this content, and `didOpen` is authoritative —
 * so seeding an editor from the committed bytes would overwrite the restored
 * document in the server's text store and silently undo the reload.
 *
 * The walk goes through `readDirectorySync`, so a file that exists only in
 * storage is included; enumerating the seed's keys instead would miss exactly
 * the files a user created.
 */
function readWorkspaceFiles(shared: OrderFlowSharedServices): WorkspaceFiles {
   const provider = shared.workspace.FileSystemProvider;
   const prefix = `${WORKSPACE_ROOT_URI}/`;
   const files: Record<string, string> = {};
   const visit = (uri: URI): void => {
      for (const node of provider.readDirectorySync(uri)) {
         if (node.isFile) {
            files[node.uri.toString().slice(prefix.length)] = provider.readFileSync(node.uri);
         } else {
            visit(node.uri);
         }
      }
   };
   visit(URI.parse(WORKSPACE_ROOT_URI));
   return files;
}

async function onBootstrap(message: BootstrapMessage): Promise<void> {
   // The one asynchronous step, and it is FIRST: the stored workspace has to be
   // in the filesystem before a head is built around it, because every read
   // below this line is synchronous and the transport cannot be made to wait.
   const fileSystem = await persistentFileSystem({
      store: workspaceStore,
      seed: ORDER_FLOW_WORKSPACE_SEED,
      rootUri: WORKSPACE_ROOT_URI
   });
   const shared = startLspHead(message.ports.lsp, fileSystem);
   startDataHead(message.ports.data, shared);
   startGlspHead(message.ports.glsp, shared);
   // After the heads, so a page never receives content for a composition that
   // failed to come up — it would open editors against a server that cannot
   // answer and report the silence as an empty workspace.
   postMessage({
      type: WORKSPACE_READY_MESSAGE_TYPE,
      files: readWorkspaceFiles(shared),
      restored: [...workspaceStore.restoredPaths]
   });
   validateWholeWorkspace(shared).catch((error: unknown) => reportError('workspace validation', error));
}

/**
 * Forget every stored edit and tell the page, which reloads.
 *
 * The live filesystem is deliberately NOT rewritten here: the language server
 * holds documents built from its current content, so replacing the map under it
 * would leave every open document at text nothing re-read. Clearing the store
 * and starting over is one code path instead of two.
 */
function onResetWorkspace(): void {
   workspaceStore
      .clear()
      .then(() => postMessage({ type: WORKSPACE_RESET_MESSAGE_TYPE }))
      .catch((error: unknown) => reportError('workspace reset', error));
}

// One bootstrap per worker: the heads are composed against a single shared
// Langium tree, so a second bootstrap would build a second tree over the same
// seed and hand out sessions that silently disagree about the workspace.
let bootstrapped = false;

// The bare global rather than `self.addEventListener`: only the former is typed
// against `DedicatedWorkerGlobalScopeEventMap`, so only the former narrows the
// handler's argument to `MessageEvent`. `self` is declared as the wider
// `WorkerGlobalScope`, where `message` is not in the event map at all.
addEventListener('message', event => {
   if (isResetWorkspaceMessage(event.data)) {
      onResetWorkspace();
      return;
   }
   if (bootstrapped || !isBootstrapMessage(event.data)) {
      return;
   }
   bootstrapped = true;
   // `.catch` rather than try/catch: the bootstrap is asynchronous now, so a
   // synchronous throw and a rejected filesystem load arrive by the same route
   // and both have to reach the page — a failing store otherwise leaves a worker
   // that started and a page that waits.
   onBootstrap(event.data).catch((error: unknown) => reportError('bootstrap', error));
});
