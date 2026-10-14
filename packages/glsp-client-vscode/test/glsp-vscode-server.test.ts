/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP's integration `require`s `vscode`, which only the extension host
// provides; `vi.mock` does not reach a dependency's own `require`.
const restoreLoad = vi.hoisted(() => {
   const nodeModule = globalThis.process.getBuiltinModule('node:module') as typeof Module & {
      _load(request: string, ...rest: unknown[]): unknown;
   };
   const { Emitter } = nodeModule.createRequire(__filename)('vscode-jsonrpc') as typeof Jsonrpc;
   const load = nodeModule._load;
   nodeModule._load = function (request: string, ...rest: unknown[]): unknown {
      return request === 'vscode' ? { EventEmitter: Emitter } : load.call(this, request, ...rest);
   };
   return (): void => {
      nodeModule._load = load;
   };
});

import { NoopLogger } from '@hydranium/protocol';
import type { Module } from 'node:module';
import * as net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as Jsonrpc from 'vscode-jsonrpc';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import { HydraniumGlspVscodeServer } from '../src/node/glsp-vscode-server';

/** A socket that answers GLSP's `initialize` the way a head does, recording the requests. */
async function startStubHead(): Promise<{ port: number; methods: string[]; close(): Promise<void> }> {
   const methods: string[] = [];
   const sockets: net.Socket[] = [];
   const server = net.createServer(socket => {
      sockets.push(socket);
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      connection.onRequest((method: string) => {
         methods.push(method);
         return method === 'initialize' ? { protocolVersion: '1.0.0', serverActions: {} } : null;
      });
      connection.listen();
   });
   await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
   return {
      port: (server.address() as net.AddressInfo).port,
      methods,
      close: () => {
         sockets.forEach(socket => socket.destroy());
         return new Promise<void>(resolve => server.close(() => resolve()));
      }
   };
}

afterAll(() => restoreLoad());

describe('HydraniumGlspVscodeServer', () => {
   it('looks the port up at start and initialises the head over it', async () => {
      const head = await startStubHead();
      let lookups = 0;
      const glspServer = new HydraniumGlspVscodeServer({
         clientId: 'client-one',
         clientName: 'One',
         findPort: async () => {
            lookups++;
            return head.port;
         },
         logger: new NoopLogger()
      });
      try {
         expect(lookups).toBe(0);

         await glspServer.start();

         await expect(glspServer.initializeResult).resolves.toHaveProperty('serverActions');
         expect(lookups).toBe(1);
         expect(head.methods).toEqual(['initialize']);
      } finally {
         glspServer.dispose();
         await head.close();
      }
   });

   it('rejects readiness when the port lookup fails', async () => {
      const glspServer = new HydraniumGlspVscodeServer({
         clientId: 'client-one',
         clientName: 'One',
         findPort: () => Promise.reject(new Error('no port')),
         logger: new NoopLogger()
      });
      try {
         await glspServer.start();

         await expect(glspServer.onReady).rejects.toThrow('no port');
      } finally {
         glspServer.dispose();
      }
   });
});
