/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The LSP head on a transferred port, headless: Node's own `MessageChannel`
 * supplies the pair, a real shared tier with no language is composed around
 * the connection the starter builds, and a client on the other port drives
 * the handshake.
 */

import {
   CONFLICT_ERROR_CODE,
   createMessagePortTransport,
   DOCUMENT_NOT_OPEN_ERROR_CODE,
   LatencyCollector,
   SaveTextDocumentRequest,
   STALE_BASE_VERSION_SAVE,
   type TransferredMessagePort
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyFileSystem, inject, type Module, URI } from '@hydranium/langium';
import { createDefaultSharedModule, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { createMessageConnection, type MessageConnection, ResponseError } from 'vscode-jsonrpc/browser';
import {
   DidChangeTextDocumentNotification,
   DidOpenTextDocumentNotification,
   InitializedNotification,
   InitializeRequest,
   type Connection,
   type InitializeResult
} from 'vscode-languageserver/browser';
import { createServerSharedModule, inMemoryFileSystem, type ServerSharedServices } from '../../src/index.js';
import { createLspServerSharedModule } from '../../src/lsp/index.js';
import { startLanguageServerInWorker } from '../../src/browser/index.js';

type SharedModule = Module<ServerSharedServices, PartialLangiumSharedServices>;

const DOCUMENT_URI = 'file:///w/a.x';

/** The shared tier as the head's doc prescribes it, around `connection`, with no grammar registered. */
function composeShared(
   connection: Connection,
   fileSystem: typeof EmptyFileSystem | ReturnType<typeof inMemoryFileSystem> = EmptyFileSystem
): ServerSharedServices {
   const context = { connection, ...fileSystem };
   return inject(
      createDefaultSharedModule(context) as unknown as SharedModule,
      createServerSharedModule(context) as unknown as SharedModule,
      createLspServerSharedModule(context) as unknown as SharedModule
   ) as unknown as ServerSharedServices;
}

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

/** The page's end: a listening connection over its port. */
function makePageEnd(port: TransferredMessagePort): MessageConnection {
   const transport = createMessagePortTransport(port);
   const connection = createMessageConnection(transport.reader, transport.writer);
   connection.listen();
   toDispose.push(connection);
   return connection;
}

function initialize(page: MessageConnection): Promise<InitializeResult> {
   return page.sendRequest(InitializeRequest.type, { processId: null, rootUri: null, capabilities: {} });
}

/** A head over a file system holding `DOCUMENT_URI`, with the editor's buffer of it open at version 1 holding `text`. */
async function openInEditor(text: string): Promise<{ shared: ServerSharedServices; page: MessageConnection }> {
   const ports = makeMessagePortPair();
   toDispose.push(ports);
   const shared = startLanguageServerInWorker(ports.port2, connection =>
      composeShared(connection, inMemoryFileSystem({ seed: { [DOCUMENT_URI]: 'on disk' } }))
   );
   const page = makePageEnd(ports.port1);
   await initialize(page);
   await page.sendNotification(InitializedNotification.type, {});
   await page.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: DOCUMENT_URI, languageId: 'x', version: 1, text }
   });
   await waitFor(() => shared.workspace.TextDocuments.get(DOCUMENT_URI) !== undefined);
   return { shared, page };
}

describe('startLanguageServerInWorker', () => {
   it('answers the handshake on the port with the tier composed around its connection', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      const composed: ServerSharedServices[] = [];
      const shared = startLanguageServerInWorker(ports.port2, connection => {
         const services = composeShared(connection);
         composed.push(services);
         return services;
      });
      const page = makePageEnd(ports.port1);

      const result = await initialize(page);

      expect(composed).toEqual([shared]);
      expect(result).toMatchObject({ capabilities: expect.any(Object) });
   });

   it('closes the language client documents when the page closes its end', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      const shared = startLanguageServerInWorker(ports.port2, composeShared);
      const closed = vi.spyOn(shared.workspace.TextDocuments, 'closeLanguageClientDocuments');
      const page = makePageEnd(ports.port1);
      await initialize(page);

      page.dispose();

      await waitFor(() => closed.mock.calls.length > 0);
   });

   it('advertises the save request under its method', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      startLanguageServerInWorker(ports.port2, composeShared);

      const result = await initialize(makePageEnd(ports.port1));

      expect(result.capabilities.experimental).toEqual({ [SaveTextDocumentRequest.method]: true });
   });

   it('writes the text the editor holds when it asks to save', async () => {
      const { shared, page } = await openInEditor('typed');

      const answer = await page.sendRequest(SaveTextDocumentRequest.method, { textDocument: { uri: DOCUMENT_URI, version: 1 } });

      expect({ answer, file: shared.workspace.FileSystemProvider.readFileSync(URI.parse(DOCUMENT_URI)) }).toEqual({
         answer: null,
         file: 'typed'
      });
   });

   it('writes the text the changes gave it when the editor saves at its own version, which the store does not share', async () => {
      const { shared, page } = await openInEditor('typed');
      // Steps the editor's version and not the store's: the text does not change.
      await page.sendNotification(DidChangeTextDocumentNotification.type, {
         textDocument: { uri: DOCUMENT_URI, version: 2 },
         contentChanges: [{ text: 'typed' }]
      });
      await page.sendNotification(DidChangeTextDocumentNotification.type, {
         textDocument: { uri: DOCUMENT_URI, version: 3 },
         contentChanges: [{ text: 'typed more' }]
      });

      await page.sendRequest(SaveTextDocumentRequest.method, { textDocument: { uri: DOCUMENT_URI, version: 3 } });

      expect({
         store: shared.workspace.TextDocuments.version(DOCUMENT_URI),
         file: shared.workspace.FileSystemProvider.readFileSync(URI.parse(DOCUMENT_URI))
      }).toEqual({ store: 2, file: 'typed more' });
   });

   it('refuses a save of a document the editor does not have open with its code', async () => {
      const { page } = await openInEditor('typed');

      const refused: unknown = await page
         .sendRequest(SaveTextDocumentRequest.method, { textDocument: { uri: 'file:///w/b.x', version: 1 } })
         .catch((error: unknown) => error);

      expect(refused).toMatchObject({ code: DOCUMENT_NOT_OPEN_ERROR_CODE, data: { uri: 'file:///w/b.x' } });
   });

   it('refuses a save of a version the editor did not declare with the conflict code and fields', async () => {
      const { shared, page } = await openInEditor('typed');

      const refused: unknown = await page
         .sendRequest(SaveTextDocumentRequest.method, { textDocument: { uri: DOCUMENT_URI, version: 2 } })
         .catch((error: unknown) => error);

      if (!(refused instanceof ResponseError)) {
         throw new Error(`Not refused with a ResponseError: ${String(refused)}`);
      }
      expect({
         code: refused.code,
         data: refused.data,
         file: shared.workspace.FileSystemProvider.readFileSync(URI.parse(DOCUMENT_URI))
      }).toMatchObject({
         code: CONFLICT_ERROR_CODE,
         data: {
            uri: DOCUMENT_URI,
            actualVersion: shared.workspace.TextDocuments.version(DOCUMENT_URI),
            hydranium: { code: STALE_BASE_VERSION_SAVE.code }
         },
         file: 'on disk'
      });
   });

   it('records the handshake in the latency collector it is given', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      const latency = new LatencyCollector();
      startLanguageServerInWorker(ports.port2, composeShared, { latency });
      const page = makePageEnd(ports.port1);

      await initialize(page);

      expect(latency.report().methods.map(method => method.method)).toContain('initialize');
   });
});
