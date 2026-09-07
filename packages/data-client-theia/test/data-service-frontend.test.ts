/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `AbstractDataServiceFrontend`'s connection lifecycle.
 *
 * These tests drive the real `start()` against a fake connection provider, so
 * the proxy really is built by `createRpcProxy` over the real channel handle.
 * The two specialised subclasses' suites stub `ensureConnected` out and so
 * reach none of it — `start`, the readiness gate and the proxy binding are
 * covered here or nowhere.
 */

import 'reflect-metadata';
import { type Channel } from '@theia/core';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { describe, expect, it } from 'vitest';
import { createChannelConnection } from '../src/browser/channel-connection';
import { AbstractDataServiceFrontend } from '../src/browser/data-service-frontend';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

class FakeConnectionProvider {
   listenCalls = 0;
   handler?: (path: unknown, channel: Channel) => void;
   listen(_path: string, handler: (path: unknown, channel: Channel) => void, _reconnect: boolean): void {
      this.listenCalls++;
      this.handler = handler;
   }
}

/**
 * Wait until the handle asks for a replacement channel.
 *
 * Real timers: the re-open is a `setTimeout` behind vscode-jsonrpc's own
 * `setImmediate`-driven message queue, and freezing the clock stalls that queue
 * too — the connections these tests build would stop delivering.
 */
async function nextListen(provider: FakeConnectionProvider): Promise<void> {
   const before = provider.listenCalls;
   const deadline = Date.now() + 5_000;
   while (provider.listenCalls === before) {
      if (Date.now() > deadline) {
         throw new Error('the handle never asked for a replacement channel');
      }
      await new Promise(resolve => setTimeout(resolve, 5));
   }
}

function makeChannelPipe(): { left: ForwardingChannel; right: ForwardingChannel } {
   const left: ForwardingChannel = new ForwardingChannel(
      'left',
      () => right.onCloseEmitter.fire({ reason: 'left closed' }),
      () => {
         const writeBuffer = new Uint8ArrayWriteBuffer();
         writeBuffer.onCommit(buffer => right.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer)));
         return writeBuffer;
      }
   );
   const right: ForwardingChannel = new ForwardingChannel(
      'right',
      () => left.onCloseEmitter.fire({ reason: 'right closed' }),
      () => {
         const writeBuffer = new Uint8ArrayWriteBuffer();
         writeBuffer.onCommit(buffer => left.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer)));
         return writeBuffer;
      }
   );
   return { left, right };
}

interface TestServerProtocol {
   waitForReady(): Promise<void>;
   ping(args: { value: string }): Promise<string>;
}

/** Inbound notification target, so a reconnect's re-binding is observable. */
class RecordingClient {
   readonly notes: string[] = [];
   onNoted(args: { note: string }): void {
      this.notes.push(args.note);
   }
}

/** Concrete subclass exposing the protected lifecycle for assertions. */
class TestFrontend extends AbstractDataServiceFrontend<TestServerProtocol, RecordingClient> {
   protected readonly workspaceService = undefined;
   protected readonly clientMethods = ['onNoted'] as const satisfies ReadonlyArray<keyof RecordingClient & string>;
   protected readonly servicePath = '/test';
   protected readonly methodNamespace = 'test/';
   readyCalls = 0;

   constructor(
      protected readonly connectionProvider: ServiceConnectionProvider,
      protected override readonly reconnectOnConnectionLoss: boolean,
      protected readonly client: RecordingClient = new RecordingClient()
   ) {
      super();
   }

   get notes(): readonly string[] {
      return this.client.notes;
   }

   run(): void {
      this.start();
   }

   get proxy(): TestServerProtocol {
      return this.server;
   }

   get initializedRef(): unknown {
      return this.initialized;
   }

   connect(): Promise<void> {
      return this.ensureConnected();
   }

   /** Count how often the readiness gate ran — one per connection generation. */
   protected override async doInitialize(initialized: { resolve(): void; reject(error: unknown): void }): Promise<void> {
      this.readyCalls++;
      try {
         await this.connectionPromise;
         await this.server.waitForReady();
         initialized.resolve();
      } catch (error) {
         initialized.reject(error);
      }
   }
}

/** Stand a server up on the far end of `channel` answering `waitForReady` + `ping`. */
function serveOn(channel: Channel, pong: string): { dispose(): void; note(text: string): void } {
   const connection = createChannelConnection(channel);
   connection.onRequest('test/waitForReady', () => null);
   connection.onRequest('test/ping', () => pong);
   connection.listen();
   return {
      dispose: () => connection.dispose(),
      note: (text: string) => connection.sendNotification('test/onNoted', { note: text })
   };
}

describe('AbstractDataServiceFrontend', () => {
   it('builds a working proxy over the channel it opened', async () => {
      const provider = new FakeConnectionProvider();
      const frontend = new TestFrontend(provider as unknown as ServiceConnectionProvider, false);
      frontend.run();
      await flush();

      const pipe = makeChannelPipe();
      const server = serveOn(pipe.right, 'first');
      provider.handler!('/test', pipe.left);

      await frontend.connect();
      expect(await frontend.proxy.ping({ value: 'x' })).toBe('first');
      expect(frontend.readyCalls).toBe(1);

      server.dispose();
      frontend.dispose();
   });

   it('rebuilds the proxy and re-runs the readiness gate on reconnect', async () => {
      const provider = new FakeConnectionProvider();
      const frontend = new TestFrontend(provider as unknown as ServiceConnectionProvider, true);
      frontend.run();
      await flush();

      const first = makeChannelPipe();
      const firstServer = serveOn(first.right, 'first');
      provider.handler!('/test', first.left);
      await frontend.connect();
      expect(await frontend.proxy.ping({ value: 'x' })).toBe('first');

      // A restarted server: the far end dies, the handle re-opens the channel,
      // and a DIFFERENT server answers on the replacement. The distinct pong is
      // what proves the proxy was rebuilt rather than still addressing the dead
      // connection — asserting only that no error was thrown would pass for a
      // proxy whose requests silently never answer, which is exactly what a
      // stale one produces.
      first.right.close();
      await nextListen(provider);
      const second = makeChannelPipe();
      const secondServer = serveOn(second.right, 'second');
      provider.handler!('/test', second.left);
      await flush();

      // The readiness gate has to run again: a restarted server has an unwarmed
      // workspace, and a stale resolved Deferred would let the first request
      // through against a server still walking it.
      expect(frontend.initializedRef).toBeUndefined();
      await frontend.connect();
      expect(frontend.readyCalls).toBe(2);
      expect(await frontend.proxy.ping({ value: 'x' })).toBe('second');

      firstServer.dispose();
      secondServer.dispose();
      frontend.dispose();
   });

   it('binds inbound notifications once per generation, not cumulatively', async () => {
      // The risk the reconnect path creates and nothing else checks: each
      // generation builds a NEW proxy, and `createRpcProxy` binds the inbound
      // client methods per connection. If the previous binding stayed live, one
      // server notification would be recorded twice — a duplicated event, which
      // for a real client means a doubled model update rather than a crash.
      const provider = new FakeConnectionProvider();
      const frontend = new TestFrontend(provider as unknown as ServiceConnectionProvider, true);
      frontend.run();
      await flush();

      const first = makeChannelPipe();
      const firstServer = serveOn(first.right, 'first');
      provider.handler!('/test', first.left);
      await frontend.connect();

      firstServer.note('before');
      await flush();
      expect(frontend.notes).toEqual(['before']);

      first.right.close();
      await nextListen(provider);
      const second = makeChannelPipe();
      const secondServer = serveOn(second.right, 'second');
      provider.handler!('/test', second.left);
      await flush();
      await frontend.connect();

      secondServer.note('after');
      await flush();

      // Exactly one 'after', and the dead server can no longer be heard at all.
      expect(frontend.notes).toEqual(['before', 'after']);

      firstServer.dispose();
      secondServer.dispose();
      frontend.dispose();
   });

   it('keeps the original connection when reconnect is off', async () => {
      const provider = new FakeConnectionProvider();
      const frontend = new TestFrontend(provider as unknown as ServiceConnectionProvider, false);
      frontend.run();
      await flush();

      const first = makeChannelPipe();
      const firstServer = serveOn(first.right, 'first');
      provider.handler!('/test', first.left);
      await frontend.connect();
      const listensAfterOpen = provider.listenCalls;

      // Losing the connection must not re-open anything, and an unsolicited
      // channel must not be adopted either. Waited on for longer than the
      // shipped first backoff step, since the assertion is an absence.
      first.right.close();
      const second = makeChannelPipe();
      const secondServer = serveOn(second.right, 'second');
      provider.handler!('/test', second.left);
      await new Promise(resolve => setTimeout(resolve, 400));

      expect(provider.listenCalls).toBe(listensAfterOpen);
      // Build-once: the gate did not re-run, and the proxy still addresses the
      // original connection rather than the second server.
      expect(frontend.readyCalls).toBe(1);
      expect(await frontend.proxy.ping({ value: 'x' }).catch(() => 'unreachable')).not.toBe('second');

      firstServer.dispose();
      secondServer.dispose();
      frontend.dispose();
   });
});
