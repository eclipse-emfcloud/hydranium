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
 * **Two options differ too, and neither is a transport concern:**
 * `highlightKeywords` and `highlightComments`. The VS Code and Theia hosts ship
 * `.tmLanguage.json` grammars that already colour both, with finer scopes than
 * the flat `keyword` and `comment` a semantic token carries — and semantic
 * tokens override TextMate, so enabling them there would make those editors
 * less coloured. This page ships no client-side grammar at all, deliberately,
 * because "the colours come from the server" is the property it exists to
 * demonstrate. Without the options the demonstration is half-made: names are
 * coloured and every keyword and comment renders in the default foreground.
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
import { PersistentFileSystemProvider, persistentFileSystem } from '@hydranium/core';
import { hostHeadsInWorker, IndexedDbFileSystemStore, reportWorkerError, startLanguageServerInWorker } from '@hydranium/core/browser';
import { DataServer } from '@hydranium/data-server';
import { startDataServerInWorker } from '@hydranium/data-server/browser';
import { createOrderFlowServices, type OrderFlowSharedServices } from '@hydranium/example-order-flow-server';
import { OrderFlowProcessDiagramModule } from '@hydranium/example-order-flow-server/lib/glsp/order-flow-process-diagram-module';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import { URI } from '@hydranium/langium';
import { LatencyCollector } from '@hydranium/protocol';
import { ORDER_FLOW_WORKSPACE_SEED } from '../generated/workspace-seed.js';
import {
   isResetWorkspaceMessage,
   WORKSPACE_READY_MESSAGE_TYPE,
   WORKSPACE_RESET_MESSAGE_TYPE,
   WORKSPACE_ROOT_URI,
   type WorkspaceFiles
} from '../head-channels.js';

/** The union of transfer roots this workspace's three grammars produce. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/**
 * The store every head persists through, and the one a page reset clears.
 *
 * Module-level rather than per-bootstrap: the reset message can arrive before or
 * after the heads exist, and a store held inside the bootstrap closure would be
 * unreachable from the message handler.
 */
const workspaceStore = new IndexedDbFileSystemStore('order-flow-browser-workspace');

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

/**
 * What the provider restored as content. The store cannot answer this: a
 * deleted seeded file is a stored entry too, and only the provider knows the
 * marker from a file. The bound slot is the scheme registry, so the host's
 * provider is read through it.
 */
function restoredPaths(shared: OrderFlowSharedServices): string[] {
   const host = shared.workspace.FileSystemProvider.host;
   return host instanceof PersistentFileSystemProvider ? [...host.restoredPaths] : [];
}

// The stored workspace is restored before any head is built around it, which
// `hostHeadsInWorker` guarantees by awaiting this before `start`; the load
// begins now rather than on the bootstrap, so the page's first message finds
// as little of it left as possible.
hostHeadsInWorker(
   persistentFileSystem({ store: workspaceStore, seed: ORDER_FLOW_WORKSPACE_SEED, rootUri: WORKSPACE_ROOT_URI }),
   (ports, fileSystem) => {
      // ONE collector for both heads: a second would split the report,
      // `getLatency` serving only what the data head was given. Ring-buffer
      // rather than the `keep-all` default, which is sized for a window that
      // gets read and reset — a page is left open, so retention has to be
      // bounded, and 200 keeps the nearest-rank p99 describing a tail rather
      // than standing in for the maximum. No env gate, unlike the Node entry:
      // a browser has none to read.
      const latency = new LatencyCollector(undefined, { kind: 'ring-buffer', maxSamplesPerMethod: 200 });
      // The services are built around the LSP connection, exactly as the Node
      // entry builds them around a stdio one.
      const shared = startLanguageServerInWorker(
         ports.lsp,
         connection =>
            createOrderFlowServices(
               { connection, ...fileSystem },
               // The options this host sets, for the reason in the module doc:
               // no client-side grammar means the server is the only source of
               // colour.
               { highlightKeywords: true, highlightComments: true }
            ).shared,
         { latency }
      );
      // The SAME shared tier, on its own port. One store, two heads — the
      // property the whole arrangement exists to demonstrate, and the reason
      // both heads must live in one worker rather than one worker each.
      startDataServerInWorker(ports.data, shared, connection => new DataServer<OrderFlowTransferRoot>(connection, shared, { latency }));
      // The composition is `order-flow-server`'s, unmodified: the same
      // `OrderFlowProcessDiagramModule` the Node entry configures, the same
      // unsubclassed `HydraniumGlspAppModule`. Only the bringup
      // differs — `startGlspServerInWorker` in place of `startGlspServer` —
      // which is the claim this head is here to make. The logger goes through
      // the LSP connection like the Node entry's, for a different reason: there
      // is no stdout to corrupt here, but a worker's console is a place nobody
      // is looking, and the LSP channel already reaches the page.
      const glsp = startGlspServerInWorker({
         context: ports.glsp,
         // No `logLevel`: the logger tracks the framework threshold, which in
         // a browser has no `HYDRANIUM_LOG_LEVEL` to read and so sits at its
         // `'info'` default until something calls `Logger.setLevel`.
         createLogger: caller => new GlspClientLogger(shared, { component: caller }),
         serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      // Only once the GLSP head is up, so a page never receives content for a
      // composition that failed to come up — it would open editors against a
      // server that cannot answer and report the silence as an empty
      // workspace. The GLSP head reports a failed launch through `started`
      // rather than by throwing, so the announcement chains on it; handed
      // back, the ready message waits for both.
      const announced = glsp.started.then(() => {
         postMessage({ type: WORKSPACE_READY_MESSAGE_TYPE, files: readWorkspaceFiles(shared), restored: restoredPaths(shared) });
      });
      return { shared, started: [announced] };
   }
);

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
      .catch((error: unknown) => reportWorkerError('workspace reset', error));
}

// This host's own message beside the framework's bootstrap, which
// `hostHeadsInWorker` answers and leaves everything else to the host.
addEventListener('message', event => {
   if (isResetWorkspaceMessage(event.data)) {
      onResetWorkspace();
   }
});
