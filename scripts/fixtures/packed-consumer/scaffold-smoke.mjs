/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection as connectSocket } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
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
   const deadline = performance.now() + 20_000;
   for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(done => setTimeout(done, 100));
   }
}

/**
 * Without an LSP head, `lib/main.js` takes the workspace path and prints the
 * ports of the socket heads as one JSON line on stdout once they listen.
 */
async function startWithoutLsp() {
   const child = spawn(process.execPath, [resolve('lib/main.js'), workspaceRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
   const stderr = [];
   child.stderr.on('data', chunk => stderr.push(chunk.toString()));
   const exited = once(child, 'exit').then(([code]) => Promise.reject(new Error(`main.js exited ${code}:\n${stderr.join('')}`)));
   exited.catch(() => undefined);
   const line = new Promise(resolveLine =>
      createInterface({ input: child.stdout }).on('line', text => text.startsWith('{') && resolveLine(text))
   );
   return { child, stderr, ports: JSON.parse(await Promise.race([line, exited])) };
}

let server;
let serverWithoutLsp;
try {
   let portOf;
   if (heads.includes('lsp')) {
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
      portOf = head => server.port(`my-lang/${head}/port`);
   } else {
      serverWithoutLsp = await startWithoutLsp();
      const { dataServer, glspServer } = serverWithoutLsp.ports;
      portOf = async head => ({ 'data-server': dataServer, 'glsp-server': glspServer })[head];
   }

   if (heads.includes('data')) {
      const dataRpc = await connect(await portOf('data-server'));
      dataRpc.listen();
      const data = createRpcProxy(dataRpc, { methodNamespace: DATA_SERVER_WIRE_PREFIX, localMethods: DATA_CLIENT_PROTOCOL_METHODS });
      await data.waitForReady();
      const document = await data.getModelDocument({ uri, includeDiagnostics: true });
      assert.equal(document.model?.root.nodes.length, 2);
      assert.equal((await data.getModelDocument({ uri: missingUri })).model, undefined);
   }

   if (heads.includes('glsp')) {
      // Imported here, because a scaffold without the GLSP head does not install the package.
      const { MINIMAL_CLIENT_ACTION_KINDS, isRejectionOrError } = await import('@hydranium/glsp-server/testing');
      const glspRpc = await connect(await portOf('glsp-server'));
      const actions = [];
      glspRpc.onNotification('process', message => {
         actions.push(message.action);
         // The client's half of a layout, without which a client-laid-out load
         // never completes. Measured nothing, which the server accepts as is.
         if (message.action.kind === 'requestBounds') {
            // A server gone mid-run fails the wait for setModel below, not
            // the process on an unhandled rejection.
            try {
               glspRpc
                  .sendNotification('process', {
                     clientId: 'scaffold-smoke',
                     action: { kind: 'computedBounds', bounds: [], revision: message.action.newRoot.revision }
                  })
                  .catch(() => undefined);
            } catch {
               // A closed connection throws rather than rejecting.
            }
         }
      });
      glspRpc.listen();
      await glspRpc.sendRequest('initialize', { applicationId: 'scaffold-smoke', protocolVersion: '1.0.0' });
      await glspRpc.sendRequest('initializeClientSession', {
         clientSessionId: 'scaffold-smoke',
         diagramType: 'my-lang',
         clientActionKinds: [...MINIMAL_CLIENT_ACTION_KINDS]
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
      // The server answers a request it fails with a rejection and may still
      // send the bounds, so they alone do not show the load succeeded; the
      // model the request is answered with does.
      await waitFor(() => actions.find(action => action.kind === 'setModel' || isRejectionOrError(action)), 'the end of the diagram load');
      assert.deepEqual(actions.filter(isRejectionOrError), []);
   }

   // The server logs over LSP; without that head its log goes to stderr.
   const errors = server
      ? server.logMessages.filter(message => message.type === 1).map(message => message.message)
      : serverWithoutLsp.stderr
           .join('')
           .split('\n')
           .filter(line => line.startsWith('[Error'));
   assert.deepEqual(errors, []);
} catch (error) {
   // A server that crashed after printing its ports shows here, not only as a failed connection.
   if (serverWithoutLsp !== undefined) {
      console.error(`main.js stderr:\n${serverWithoutLsp.stderr.join('')}`);
   }
   throw error;
} finally {
   for (const { socket, rpc } of opened) {
      rpc.dispose();
      socket.destroy();
   }
   await server?.dispose();
   serverWithoutLsp?.child.kill();
}
