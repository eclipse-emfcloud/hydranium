/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Deferred, Disposable } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type ResponseMessage } from 'vscode-jsonrpc/node';
import { publishPortOnLspConnection, startSocketServer } from '../../src/node/socket-launcher.js';
import { makeAttributingLogger, makeNoopSharedServices } from '../../src/testing/index.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';

/** Services composed around an LSP connection, whose client brings the workspace up. */
const lspShared = makeNoopSharedServices({ lsp: { Connection: {} } });

/** Services with no LSP head, whose workspace manager's `initialized` is `initialized`. */
function sharedWithoutLsp(initialized: () => Promise<void>): ServerSharedServicesMinimal {
   return makeNoopSharedServices({ workspace: { WorkspaceManager: { initialize: () => undefined, initialized } } });
}

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
      const handle = startSocketServer({ shared: lspShared, port: 0, logTag: 'TestServer' }, _connection => {
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
      const handle = startSocketServer({ shared: lspShared, port: 0 }, () => Disposable.EMPTY);
      await handle.started;
      expect(await dial(handle.port!, '127.0.0.1')).toBe('connected');
      // The IPv6 loopback is a DIFFERENT address, so an IPv4-loopback binding
      // refuses it. This is what distinguishes the default from the every-
      // interface binding, which answers on both.
      expect(await dial(handle.port!, '::1')).not.toBe('connected');
      handle.close();
      await handle.stopped;
   });

   it('serves every interface for host `::`', async () => {
      if (!(await hasIpv6Loopback())) {
         // Nothing to distinguish on a machine with no IPv6: the escape hatch
         // and the default would both answer on IPv4 alone.
         return;
      }
      const handle = startSocketServer({ shared: lspShared, port: 0, host: '::' }, () => Disposable.EMPTY);
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
      const handle = startSocketServer({ shared: lspShared, port: 0, host: '192.0.2.1' }, () => Disposable.EMPTY);
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

      const handle = startSocketServer({ shared: lspShared, port: addressInfo.port }, () => Disposable.EMPTY);
      // The errno, not just "some rejection": the launcher rejects `started` for
      // several unrelated reasons (unresolvable address info, a pipe instead of a
      // TCP socket), and those carry a plain Error with no `code`.
      await expect(handle.started).rejects.toMatchObject({ code: 'EADDRINUSE' });

      blocker.close();
   });

   it("logs the connection's protocol faults through the logger, under the head's tag", async () => {
      const { logger, lines } = makeAttributingLogger();
      const handle = startSocketServer({ shared: lspShared, port: 0, logger, logTag: 'TestServer' }, () => Disposable.EMPTY);
      await handle.started;
      const socket = net.connect({ port: handle.port!, host: '127.0.0.1' });
      try {
         const response: ResponseMessage = { jsonrpc: '2.0', id: null, result: null };
         await new SocketMessageWriter(socket).write(response);

         const fault = 'Received response message without id. No further error information provided.';
         await waitFor(() => lines.some(line => line.message === fault));
         expect(lines).toContainEqual({ component: 'TestServer', level: 'error', message: fault });
      } finally {
         socket.destroy();
         handle.close();
         await handle.stopped;
      }
   });
});

describe('startSocketServer without an LSP head', () => {
   it('brings the workspace up before it listens', async () => {
      const gate = new Deferred<void>();
      let started = false;
      const handle = startSocketServer({ shared: sharedWithoutLsp(() => gate.promise), workspace: '/ws' }, () => Disposable.EMPTY);
      void handle.started.then(() => {
         started = true;
      });

      // A timer, so a launcher that listened first would have resolved by now.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect({ started, port: handle.port }).toEqual({ started: false, port: undefined });

      gate.resolve();
      await handle.started;
      expect(await dial(handle.port!, '127.0.0.1')).toBe('connected');
      handle.close();
      await handle.stopped;
   });

   it('rejects `started` and listens nowhere without a workspace, logging the mistake', async () => {
      const { logger, lines } = makeAttributingLogger();
      const handle = startSocketServer({ shared: sharedWithoutLsp(async () => undefined), logger }, () => Disposable.EMPTY);

      await expect(handle.started).rejects.toThrow(/nothing initialises the workspace/);
      await expect(handle.stopped).resolves.toBeUndefined();
      expect({ port: handle.port, errors: lines.filter(line => line.level === 'error').length }).toEqual({ port: undefined, errors: 1 });
   });

   it('rejects `started` without logging an error when the workspace fails to initialize', async () => {
      const { logger, lines } = makeAttributingLogger();
      const handle = startSocketServer(
         { shared: sharedWithoutLsp(() => Promise.reject(new Error('discovery blew up'))), workspace: '/ws', logger },
         () => Disposable.EMPTY
      );

      await expect(handle.started).rejects.toThrow(/discovery blew up/);
      await expect(handle.stopped).resolves.toBeUndefined();
      expect(lines.filter(line => line.level === 'error')).toEqual([]);
   });

   it('never listens once closed during the bring-up', async () => {
      const gate = new Deferred<void>();
      const handle = startSocketServer({ shared: sharedWithoutLsp(() => gate.promise), workspace: '/ws' }, () => Disposable.EMPTY);
      handle.close();
      await handle.stopped;

      gate.resolve();
      await expect(handle.started).rejects.toThrow(/closed before it listened/);
      expect(handle.port).toBeUndefined();
   });

   it('leaves a close during the bring-up no unhandled rejection when nobody awaits `started`', async () => {
      const gate = new Deferred<void>();
      const handle = startSocketServer({ shared: sharedWithoutLsp(() => gate.promise), workspace: '/ws' }, () => Disposable.EMPTY);
      handle.close();
      await handle.stopped;

      gate.resolve();
      // A rejection is reported as unhandled once the microtasks have drained.
      await new Promise(resolve => setTimeout(resolve, 0));
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
