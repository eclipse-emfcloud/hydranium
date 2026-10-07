/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection as connectSocket } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSpawnedServer } from '@hydranium/core/testing/node';
import { createRpcProxy } from '@hydranium/protocol';
import { DATA_CLIENT_PROTOCOL_METHODS, DATA_SERVER_WIRE_PREFIX } from '@hydranium/protocol/data';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

const workspaceRoot = resolve('workspace');
const filePath = resolve(workspaceRoot, 'model.my-lang');
const uri = pathToFileURL(filePath).toString();
const missingUri = pathToFileURL(resolve(workspaceRoot, 'missing.my-lang')).toString();
const text = 'node first -> second\nnode second\n';
const heads = (process.argv[2] ?? 'lsp,data,glsp').split(',');
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(filePath, text);
const opened = [];

async function connect(port) {
   const socket = await new Promise((resolveSocket, rejectSocket) => {
      const pending = connectSocket({ host: '127.0.0.1', port });
      pending.once('connect', () => resolveSocket(pending));
      pending.once('error', rejectSocket);
   });
   const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
   rpc.onError(() => undefined);
   rpc.onClose(() => undefined);
   opened.push({ socket, rpc });
   return rpc;
}

async function waitFor(find, what) {
   const deadline = Date.now() + 20_000;
   for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(done => setTimeout(done, 100));
   }
}

let server;
try {
   server = await startSpawnedServer({ serverModule: resolve('lib/main.js'), workspaceRoot });
   assert.ok(server.initializeResult.capabilities.textDocumentSync);
   const fromIndex = server.diagnostics.length;
   server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'my-lang', version: 1, text } });
   assert.deepEqual(await server.nextDiagnostics(uri, { fromIndex }), []);
   // Langium returns this error rather than throwing it, and a connection on
   // another protocol copy sends a returned error as a result.
   await assert.rejects(server.connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri: missingUri } }), {
      code: -32802
   });

   if (heads.includes('data')) {
      const dataRpc = await connect(await server.port('my-lang/data-server/port'));
      dataRpc.listen();
      const data = createRpcProxy(dataRpc, { methodNamespace: DATA_SERVER_WIRE_PREFIX, localMethods: DATA_CLIENT_PROTOCOL_METHODS });
      await data.waitForReady();
      const document = await data.getModelDocument({ uri, includeDiagnostics: true });
      assert.equal(document.model?.root.nodes.length, 2);
      assert.equal((await data.getModelDocument({ uri: missingUri })).model, undefined);
   }

   if (heads.includes('glsp')) {
      const glspRpc = await connect(await server.port('my-lang/glsp/port'));
      const actions = [];
      glspRpc.onNotification('process', message => actions.push(message.action));
      glspRpc.listen();
      await glspRpc.sendRequest('initialize', { applicationId: 'scaffold-smoke', protocolVersion: '1.0.0' });
      await glspRpc.sendRequest('initializeClientSession', {
         clientSessionId: 'scaffold-smoke',
         diagramType: 'my-lang',
         clientActionKinds: [
            'setModel',
            'updateModel',
            'setDirtyState',
            'status',
            'message',
            'requestBounds',
            'startProgress',
            'endProgress'
         ]
      });
      glspRpc.sendNotification('process', {
         clientId: 'scaffold-smoke',
         action: { kind: 'requestModel', requestId: '', options: { sourceUri: filePath, diagramType: 'my-lang' } }
      });
      const model = await waitFor(
         () => actions.find(action => action.kind === 'setModel' || action.kind === 'requestBounds'),
         'the diagram model'
      );
      assert.equal(model.newRoot.children.filter(child => child.type.startsWith('node')).length, 2);
   }

   assert.deepEqual(
      server.logMessages.filter(message => message.type === 1).map(message => message.message),
      []
   );
} finally {
   for (const { socket, rpc } of opened) {
      rpc.dispose();
      socket.destroy();
   }
   await server?.dispose();
}
