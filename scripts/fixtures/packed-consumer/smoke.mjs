/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { createConnection as connectSocket } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSpawnedServer } from '@hydranium/core/testing/node';
import { createRpcProxy } from '@hydranium/protocol';
import { DATA_CLIENT_PROTOCOL_METHODS, DATA_SERVER_WIRE_PREFIX } from '@hydranium/protocol/data';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

const workspaceRoot = resolve('workspace');
const uri = pathToFileURL(resolve(workspaceRoot, 'catalogue.bookstore')).toString();
let server;
let socket;
let rpc;
try {
   server = await startSpawnedServer({ serverModule: resolve('lib/main.js'), workspaceRoot });
   assert.ok(server.initializeResult.capabilities.textDocumentSync);
   const fromIndex = server.diagnostics.length;
   server.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'bookstore', version: 1, text: 'node Bookstore\nnode Fiction -> Bookstore\n' }
   });
   assert.deepEqual(await server.nextDiagnostics(uri, { fromIndex }), []);

   const port = await server.port('bookstore/data-server/port');
   socket = await new Promise((resolveSocket, rejectSocket) => {
      const pending = connectSocket({ host: '127.0.0.1', port });
      pending.once('connect', () => resolveSocket(pending));
      pending.once('error', rejectSocket);
   });
   rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
   rpc.onError(() => undefined);
   rpc.onClose(() => undefined);
   rpc.listen();
   const data = createRpcProxy(rpc, { methodNamespace: DATA_SERVER_WIRE_PREFIX, localMethods: DATA_CLIENT_PROTOCOL_METHODS });
   await data.waitForReady();
   const document = await data.getModelDocument({ uri, includeDiagnostics: true });
   assert.equal(document.uri, uri);
   assert.equal(document.root?.$type, 'BookstoreModel');
   assert.equal(document.root.nodes.length, 2);
} finally {
   rpc?.dispose();
   socket?.destroy();
   await server?.dispose();
}
