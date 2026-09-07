/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable } from '@hydranium/protocol';
import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import { publishPortOnLspConnection, startSocketServer } from '../../src/node/socket-launcher.js';

describe('startSocketServer', () => {
   it('binds an ephemeral port, accepts a client, and disposes adopter+connection on shutdown', async () => {
      const adopterDispositions: number[] = [];
      const handle = startSocketServer({ port: 0, logTag: 'TestServer' }, _connection => {
         const id = adopterDispositions.length;
         adopterDispositions.push(0);
         return {
            dispose: () => {
               adopterDispositions[id] = 1;
            }
         };
      });

      await handle.started;
      expect(typeof handle.port).toBe('number');
      expect(handle.port).toBeGreaterThan(0);

      // Connect a client; wait for the adopter callback to run.
      await new Promise<void>(resolve => {
         const socket = net.connect({ port: handle.port! }, () => {
            const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
            connection.listen();
            // Give the server side one tick to invoke onClientConnection.
            setTimeout(() => {
               socket.end();
               connection.dispose();
               resolve();
            }, 50);
         });
      });

      // Give the server a moment to register the adopter disposable.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(adopterDispositions.length).toBe(1);

      handle.close();
      await handle.stopped;

      // After shutdown, all adopter disposables have been invoked.
      expect(adopterDispositions.every(value => value === 1)).toBe(true);
   });

   it('rejects `started` on listen error (port already in use)', async () => {
      // Bind an ephemeral port, then try to bind a second server to the same port —
      // the second one fails with EADDRINUSE.
      const blocker = net.createServer().listen(0);
      await new Promise<void>(resolve => blocker.on('listening', () => resolve()));
      const addressInfo = blocker.address();
      if (!addressInfo || typeof addressInfo === 'string') {
         throw new Error('Could not bind blocker server');
      }

      const handle = startSocketServer({ port: addressInfo.port }, () => Disposable.EMPTY);
      // The errno, not just "some rejection": the launcher rejects `started` for
      // several unrelated reasons (unresolvable address info, a pipe instead of a
      // TCP socket), and those carry a plain Error with no `code`.
      await expect(handle.started).rejects.toMatchObject({ code: 'EADDRINUSE' });

      blocker.close();
   });
});

describe('publishPortOnLspConnection', () => {
   it('registers a request handler that returns the port', () => {
      const registrations: Array<{ method: string; result: unknown }> = [];
      const fakeConnection = {
         onRequest<TParams, TResult>(method: string, handler: (...params: TParams[]) => TResult): { dispose(): void } {
            registrations.push({ method, result: handler() });
            return Disposable.EMPTY;
         }
      };
      const disposable = publishPortOnLspConnection(fakeConnection, 'my/port-command', 4711);
      expect(registrations).toEqual([{ method: 'my/port-command', result: 4711 }]);
      expect(typeof disposable.dispose).toBe('function');
   });

   it('returns a no-op disposable when the LSP connection is undefined', () => {
      const disposable = publishPortOnLspConnection(undefined, 'my/port-command', 4711);
      expect(typeof disposable.dispose).toBe('function');
      // Should not throw.
      disposable.dispose();
   });
});
