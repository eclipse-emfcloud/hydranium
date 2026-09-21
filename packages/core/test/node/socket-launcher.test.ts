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

/**
 * Dial `host:port` and report how it settled: `'connected'`, or the errno the
 * attempt failed with. Returning rather than throwing keeps a refusal — which
 * several cases assert — an ordinary value instead of a rejection to unwrap.
 */
async function dial(port: number, host: string): Promise<string> {
   return new Promise<string>(resolve => {
      const socket = net.connect({ port, host }, () => {
         socket.destroy();
         resolve('connected');
      });
      socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
   });
}

/**
 * Whether this machine can bind and dial `::1`. The every-interface case needs
 * it to say anything: with no IPv6 present that binding and the loopback
 * default are indistinguishable.
 */
async function hasIpv6Loopback(): Promise<boolean> {
   return new Promise<boolean>(resolve => {
      const probe = net.createServer();
      probe.on('error', () => resolve(false));
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
   });
}

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

      // Connect a client; wait for the adopter callback to run. Dialling the
      // loopback address rather than letting Node resolve `localhost` keeps this
      // off the address-family hazard the default binding creates.
      await new Promise<void>(resolve => {
         const socket = net.connect({ port: handle.port!, host: '127.0.0.1' }, () => {
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

   it('binds loopback by default, leaving the head unreachable on any other address', async () => {
      const handle = startSocketServer({ port: 0 }, () => Disposable.EMPTY);
      await handle.started;
      expect(await dial(handle.port!, '127.0.0.1')).toBe('connected');
      // The IPv6 loopback is a DIFFERENT address, so an IPv4-loopback binding
      // refuses it. This is what distinguishes the default from the every-
      // interface binding, which answers on both.
      expect(await dial(handle.port!, '::1')).not.toBe('connected');
      handle.close();
      await handle.stopped;
   });

   it("serves every interface for host '::'", async () => {
      if (!(await hasIpv6Loopback())) {
         // Nothing to distinguish on a machine with no IPv6: the escape hatch
         // and the default would both answer on IPv4 alone.
         return;
      }
      const handle = startSocketServer({ port: 0, host: '::' }, () => Disposable.EMPTY);
      await handle.started;
      // Dual-stack: `'::'` is the any-address, so both families connect. This is
      // the spelling that restores the pre-default-loopback binding.
      expect(await dial(handle.port!, '127.0.0.1')).toBe('connected');
      expect(await dial(handle.port!, '::1')).toBe('connected');
      handle.close();
      await handle.stopped;
   });

   it('rejects `started` when no local interface holds the host', async () => {
      // TEST-NET-1 (RFC 5737) is assigned to no local interface, so the kernel
      // refuses the bind rather than silently widening it.
      const handle = startSocketServer({ port: 0, host: '192.0.2.1' }, () => Disposable.EMPTY);
      await expect(handle.started).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
   });

   it('rejects `started` on listen error (port already in use)', async () => {
      // Bind an ephemeral port, then try to bind a second server to the same port —
      // the second one fails with EADDRINUSE. The blocker takes the SAME address
      // the launcher defaults to: whether a dual-stack holder also blocks an
      // IPv4-loopback bind is platform-dependent, so contending for one address
      // is what makes the collision the assertion rather than the platform.
      const blocker = net.createServer().listen(0, '127.0.0.1');
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
