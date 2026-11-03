/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultHydraniumWorkspaceLock, ReadLockWaitError, serverSharedFactory } from '@hydranium/core';
import { startLanguageServer } from '@hydranium/core/lsp';
import { createRequestHandler } from '@hydranium/langium/lsp';
import { DefaultFileSystemProvider } from '@hydranium/core/node';
import {
   disposeScratchWorkspace,
   type LspServerConnection,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { Deferred, DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DocumentSymbolParams, type Hover, type HoverParams } from 'vscode-languageserver';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';

const GRACE_MS = 100;
const TEXT = 'entity Crate {\n   a : string\n}\n';

let transport: LspServerConnection | undefined;
let shared: OrderFlowSharedServices | undefined;
let workspace: ScratchWorkspace | undefined;

afterEach(async () => {
   transport?.dispose();
   transport = undefined;
   const disposing = disposeScratchWorkspace(workspace, shared);
   shared = undefined;
   workspace = undefined;
   await disposing;
});

/** A server whose domain hover rebuilds the document it is asked about. */
async function startServer(): Promise<{ client: LspServerConnection['client']; uri: string }> {
   workspace = makeScratchWorkspace();
   workspace.write('crate.domain', TEXT);
   const uri = URI.file(workspace.resolve('crate.domain')).toString();
   transport = makeLspServerConnection();
   const services = createOrderFlowServices(
      {
         connection: transport.serverConnection,
         fileSystemProvider: serverSharedFactory(context => new DefaultFileSystemProvider(context))
      },
      {
         extraSharedModules: [
            {
               workspace: {
                  WorkspaceLock: (context: OrderFlowSharedServices) =>
                     new DefaultHydraniumWorkspaceLock(context, { readWaitGraceMs: GRACE_MS })
               }
            }
         ]
      }
   );
   shared = services.shared;
   const models = services.shared.model.ModelService;
   const provider = services.Domain.lsp.HoverProvider!;
   Object.assign(provider, {
      getHoverContent: async (document: LangiumDocument): Promise<Hover | undefined> => {
         await models.rebuild(document.uri.toString());
         return undefined;
      }
   });
   startLanguageServer(services.shared);
   await transport.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   await models.ensureDocumentState(uri, DocumentState.Validated);
   return { client: transport.client, uri };
}

// A browser host has no async context, and Langium awaits the document before it calls the provider, so there the wait hangs.
describe('a document request on Node', () => {
   it('is refused when its provider rebuilds the document', async () => {
      const { client, uri } = await startServer();

      const answer = client.sendRequest('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 8 } });

      await expect(answer).rejects.toThrow(new ReadLockWaitError(`A build of ${uri}`).message);
   });

   it('is refused when its provider rebuilds the document after a shorter request on it has ended', async () => {
      const { client, uri } = await startServer();
      // Without a required state, Langium queues both reads and starts them together once the build ends.
      const connection = transport!.serverConnection;
      // Each handler queues its read right after it is called, so the arrivals tell when both are queued.
      let arrived = 0;
      const hoverHandler = createRequestHandler(
         (services, document, params: HoverParams) => services.lsp?.HoverProvider?.getHoverContent(document, params),
         shared!
      );
      const symbolsHandler = createRequestHandler(
         (services, document, params: DocumentSymbolParams) => services.lsp?.DocumentSymbolProvider?.getSymbols(document, params),
         shared!
      );
      connection.onRequest('test/hover', (params: HoverParams, token) => {
         arrived++;
         return hoverHandler(params, token);
      });
      connection.onRequest('test/symbols', (params: DocumentSymbolParams, token) => {
         arrived++;
         return symbolsHandler(params, token);
      });
      const gate = new Deferred<void>();
      const holding = shared!.workspace.DocumentBuilder.onBuildPhase(DocumentState.Parsed, () => gate.promise);
      const building = shared!.model.ModelService.rebuild(uri);

      const answer = client.sendRequest('test/hover', { textDocument: { uri }, position: { line: 0, character: 8 } });
      const symbols = client.sendRequest('test/symbols', { textDocument: { uri } });
      await vi.waitFor(() => expect(arrived).toBe(2));
      holding.dispose();
      gate.resolve();
      await building;

      await expect(symbols).resolves.toBeDefined();
      await expect(answer).rejects.toThrow(new ReadLockWaitError(`A build of ${uri}`).message);
   });
});
