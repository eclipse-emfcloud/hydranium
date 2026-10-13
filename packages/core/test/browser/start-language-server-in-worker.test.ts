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

import { createMessagePortTransport, LatencyCollector, type TransferredMessagePort } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyFileSystem, inject, type Module } from '@hydranium/langium';
import { createDefaultSharedModule, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import { InitializeRequest, type Connection } from 'vscode-languageserver/browser';
import { createServerSharedModule, type ServerSharedServices } from '../../src/index.js';
import { createLspServerSharedModule } from '../../src/lsp/index.js';
import { startLanguageServerInWorker } from '../../src/browser/index.js';

type SharedModule = Module<ServerSharedServices, PartialLangiumSharedServices>;

/** The shared tier as the head's doc prescribes it, around `connection`, with no grammar registered. */
function composeShared(connection: Connection): ServerSharedServices {
   const context = { connection, ...EmptyFileSystem };
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

function initialize(page: MessageConnection): Promise<unknown> {
   return page.sendRequest(InitializeRequest.type, { processId: null, rootUri: null, capabilities: {} });
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
