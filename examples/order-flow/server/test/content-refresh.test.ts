/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumLangiumDocumentFactory } from '@hydranium/core';
import { startLanguageServer } from '@hydranium/core/lsp';
import { makeLspServerConnection, type LspServerConnection } from '@hydranium/core/testing/node';
import { CstUtils, isOperationCancelled, type LangiumDocument, URI } from '@hydranium/langium';
import { Deferred } from '@hydranium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CancellationToken, CancellationTokenSource, type ClientCapabilities } from 'vscode-languageserver';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';

let composed: LspServerConnection | undefined;
afterEach(() => {
   composed?.dispose();
   composed = undefined;
});

/** Resolves once the client has every message the server sent before this, since one connection keeps their order. */
async function allDelivered(connection: LspServerConnection): Promise<void> {
   const arrived = new Deferred<void>();
   const listening = connection.client.onNotification('test/delivered', () => arrived.resolve());
   await connection.serverConnection.sendNotification('test/delivered');
   await arrived.promise;
   listening.dispose();
}

/** Start a server for a client with `capabilities`, and record the refreshes it is asked for. */
async function start(capabilities: ClientCapabilities) {
   composed = makeLspServerConnection();
   const connection = composed;
   const refreshed: string[] = [];
   composed.client.onRequest('workspace/textDocumentContent/refresh', (params: { uri: string }) => {
      refreshed.push(params.uri);
   });
   const services = createOrderFlowServices({ connection: composed.serverConnection });
   startLanguageServer(services.shared);
   await composed.initialize({ capabilities });
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   await allDelivered(composed);
   // Forgets the start's own refreshes, which its load of the content documents sends.
   refreshed.length = 0;
   return {
      client: composed.client,
      builder: services.shared.workspace.DocumentBuilder,
      documents: services.shared.workspace.LangiumDocuments,
      factory: services.shared.workspace.LangiumDocumentFactory,
      delivered: () => allDelivered(connection),
      refreshed
   };
}

describe('content document refresh', () => {
   it('asks the client to request a content document again once a build has parsed its change', async () => {
      const { client, builder, delivered, refreshed } = await start({ workspace: { textDocumentContent: {} } });
      const file = URI.parse('file:///elsewhere.domain');
      await client.sendNotification('textDocument/didOpen', {
         textDocument: { uri: file.toString(), languageId: 'domain', version: 1, text: 'entity Elsewhere {\n}\n' }
      });

      await builder.update([ORDER_FLOW_STDLIB_URI, file], []);
      await delivered();

      expect(refreshed).toEqual([ORDER_FLOW_STDLIB_URI.toString()]);
   });

   it('asks for a content document a cancelled build had not parsed yet once the next build has', async () => {
      const { builder, delivered, refreshed } = await start({ workspace: { textDocumentContent: {} } });
      const cancellation = new CancellationTokenSource();

      const cancelled = builder.update([ORDER_FLOW_STDLIB_URI], [], cancellation.token);
      cancellation.cancel();
      await expect(cancelled).rejects.toSatisfy(isOperationCancelled);
      await delivered();
      const afterCancelled = [...refreshed];
      await builder.update([], []);
      await delivered();

      expect({ afterCancelled, refreshed }).toEqual({ afterCancelled: [], refreshed: [ORDER_FLOW_STDLIB_URI.toString()] });
   });

   it('waits for a build that parses the content document, not one that parses only others', async () => {
      const { builder, documents, factory, delivered, refreshed } = await start({ workspace: { textDocumentContent: {} } });
      const other = factory.fromString('entity Elsewhere {\n}\n', URI.parse('memory:///elsewhere.domain'));
      documents.addDocument(other);
      const cancellation = new CancellationTokenSource();
      const cancelled = builder.update([ORDER_FLOW_STDLIB_URI], [], cancellation.token);
      cancellation.cancel();
      await expect(cancelled).rejects.toSatisfy(isOperationCancelled);

      await builder.build([other]);
      await delivered();
      const afterOthers = [...refreshed];
      await builder.update([], []);
      await delivered();

      expect({ afterOthers, refreshed }).toEqual({ afterOthers: [], refreshed: [ORDER_FLOW_STDLIB_URI.toString()] });
   });

   it('holds a virtual document without the BOM its text had, so its positions are those an editor shows', async () => {
      const { factory } = await start({ workspace: { textDocumentContent: {} } });
      const text = '\uFEFFentity Order {\n}\n';
      const nameStart = (document: LangiumDocument): number | undefined => {
         const root = document.parseResult.value.$cstNode;
         return root && CstUtils.streamCst(root).find(node => node.text === 'Order')?.range.start.character;
      };
      const virtual = [
         factory.fromString(text, URI.parse('virtual:bom/sync.domain')),
         await factory.fromString(text, URI.parse('virtual:bom/async.domain'), CancellationToken.None),
         factory instanceof HydraniumLangiumDocumentFactory
            ? factory.fromStringInLanguage(text, URI.parse('virtual:bom/by-language.domain'), 'order-flow-domain')
            : undefined
      ];
      const file = factory.fromString(text, URI.parse('memory:///bom/file.domain'));

      expect({
         virtual: virtual.map(document => document && { text: document.textDocument.getText(), nameStart: nameStart(document) }),
         file: nameStart(file)
      }).toEqual({ virtual: Array(3).fill({ text: 'entity Order {\n}\n', nameStart: 7 }), file: 8 });
   });

   it('asks the client to request a deleted content document again, which the server then answers with none', async () => {
      const { client, builder, delivered, refreshed } = await start({ workspace: { textDocumentContent: {} } });

      await builder.update([], [ORDER_FLOW_STDLIB_URI]);
      await delivered();
      const content: unknown = await client.sendRequest('workspace/textDocumentContent', { uri: ORDER_FLOW_STDLIB_URI.toString() });

      expect({ refreshed, content }).toEqual({ refreshed: [ORDER_FLOW_STDLIB_URI.toString()], content: null });
   });

   it('builds on when the client that declared content support has left', async () => {
      const { builder } = await start({ workspace: { textDocumentContent: {} } });
      composed?.serverConnection.dispose();

      await expect(builder.update([ORDER_FLOW_STDLIB_URI], [])).resolves.toBeUndefined();
   });

   it('asks nothing of a client that declared no content support', async () => {
      const { builder, delivered, refreshed } = await start({});

      await builder.update([ORDER_FLOW_STDLIB_URI], []);
      await builder.update([], [ORDER_FLOW_STDLIB_URI]);
      await delivered();

      expect(refreshed).toEqual([]);
   });
});
