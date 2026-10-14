/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head on a transferred port, headless: Node's own `MessageChannel`
 * supplies the pair, and a client proxy on the other port drives the head the
 * starter built.
 */

import { createMessagePortTransport, createRpcProxy, type TransferDiagnostic, type TransferredMessagePort } from '@hydranium/protocol';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '@hydranium/protocol/data';
import { waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import type { AstDiagnostic } from '@hydranium/core';
import { makeTestServices } from '@hydranium/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import { DataServer } from '../../src/data-server.js';
import { startDataServerInWorker } from '../../src/browser/index.js';

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

/** The page's end: a listening connection over its port, and a proxy on it. */
function makePageEnd(port: TransferredMessagePort): { connection: MessageConnection; proxy: DataServerProtocol<FakeRoot> } {
   const transport = createMessagePortTransport(port);
   const connection = createMessageConnection(transport.reader, transport.writer);
   connection.listen();
   toDispose.push(connection);
   return { connection, proxy: createRpcProxy<DataServerProtocol<FakeRoot>>(connection, { methodNamespace: DATA_SERVER_WIRE_PREFIX }) };
}

describe('startDataServerInWorker', () => {
   it('answers on the port with the server the host created, and returns it', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      const bundle = makeTestServices<FakeRoot, AstDiagnostic, FakeRoot>();
      const created: DataServer<FakeRoot>[] = [];
      const server = startDataServerInWorker(ports.port2, bundle.services, connection => {
         const dataServer = new DataServer<FakeRoot, TransferDiagnostic>(connection, bundle.services);
         created.push(dataServer);
         return dataServer;
      });
      toDispose.push(server);
      const page = makePageEnd(ports.port1);

      await page.proxy.createSession({ clientId: 'page' });

      expect(created).toEqual([server]);
   });

   it('disposes the server when the page closes its end', async () => {
      const ports = makeMessagePortPair();
      toDispose.push(ports);
      const bundle = makeTestServices<FakeRoot, AstDiagnostic, FakeRoot>();
      const server = startDataServerInWorker(
         ports.port2,
         bundle.services,
         connection => new DataServer<FakeRoot, TransferDiagnostic>(connection, bundle.services)
      );
      toDispose.push(server);
      const disposed = vi.spyOn(server, 'dispose');
      const page = makePageEnd(ports.port1);
      await page.proxy.createSession({ clientId: 'page' });

      page.connection.dispose();

      await waitFor(() => disposed.mock.calls.length > 0);
   });
});
