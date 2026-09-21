/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { type Channel, Disposable, type ILogger } from '@theia/core';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import type { MessageProvider } from '@theia/core/lib/common/message-rpc/channel';
import type * as net from 'node:net';
import {
   AbstractSocketForwardingConnectionHandler,
   type SocketForwardingConnectionHandlerOptions
} from '../src/node/abstract-socket-forwarding-connection-handler';

/** Concrete subclass — the base is abstract via `forwardToSocketConnection`.
 *  The `@inject`ed MessageService / CommandService fields stay unset; the
 *  option-storage behaviour under test doesn't touch them. */
class TestHandler extends AbstractSocketForwardingConnectionHandler {
   protected forwardToSocketConnection(_clientChannel: Channel, _socket: net.Socket): Disposable {
      return Disposable.create(() => {});
   }
   /** Reach the protected race fix under test. */
   replay(channel: Channel, buffered: MessageProvider[]): void {
      this.replayBufferedMessages(channel, buffered);
   }

   /** Reach the protected dial under test. */
   connect(channel: Channel, port: number): Promise<void> {
      return this.connectToServer(channel, port);
   }

   /** Expose the protected configuration the base derives from its options. */
   get config(): {
      portCommand: string;
      logComponent: string;
      serverName: string;
      findPortTimeout: number;
      findPortAttempts: number;
      connectTimeoutMs: number;
   } {
      return {
         portCommand: this.portCommand,
         logComponent: this.logComponent,
         serverName: this.serverName,
         findPortTimeout: this.findPortTimeout,
         findPortAttempts: this.findPortAttempts,
         connectTimeoutMs: this.connectTimeoutMs
      };
   }
}

const baseOptions = (): SocketForwardingConnectionHandlerOptions => ({
   path: '/services/test',
   portCommand: 'test:port',
   logComponent: 'Test',
   serverName: 'Test Server'
});

describe('AbstractSocketForwardingConnectionHandler', () => {
   it('stores the resolved path, port command, and labels', () => {
      const handler = new TestHandler(baseOptions());
      expect(handler.path).toBe('/services/test');
      expect(handler.config.portCommand).toBe('test:port');
      expect(handler.config.logComponent).toBe('Test');
      expect(handler.config.serverName).toBe('Test Server');
   });

   it('applies tuning defaults when not provided', () => {
      const handler = new TestHandler(baseOptions());
      expect(handler.config.findPortTimeout).toBe(500);
      expect(handler.config.findPortAttempts).toBe(-1);
      expect(handler.config.connectTimeoutMs).toBe(10000);
   });

   it('honours explicit tuning overrides', () => {
      const handler = new TestHandler({ ...baseOptions(), findPortTimeout: 50, findPortAttempts: 3, connectTimeoutMs: 1234 });
      expect(handler.config.findPortTimeout).toBe(50);
      expect(handler.config.findPortAttempts).toBe(3);
      expect(handler.config.connectTimeoutMs).toBe(1234);
   });

   /**
    * The heads bind `127.0.0.1`, so the dial has to name that address rather
    * than leave Node to resolve its `localhost` default: on a dual-stack machine
    * where `localhost` yields `::1` first, the connection is refused by an
    * address family nothing in the error names.
    */
   it('dials the loopback address the heads bind, not the resolver default', async () => {
      const connectCalls: unknown[] = [];
      const handler = new TestHandler({
         ...baseOptions(),
         connectTimeoutMs: 1,
         onSocketCreated: socket => {
            // Replace the dial before the base calls it, so the assertion needs
            // no listening server and opens no real connection.
            socket.connect = ((...args: unknown[]) => {
               connectCalls.push(args[0]);
               return socket;
            }) as typeof socket.connect;
         }
      });
      (handler as unknown as { logger: ILogger }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;

      const channel = new ForwardingChannel(
         'test',
         () => {},
         () => {
            throw new Error('write buffer not needed for this test');
         }
      );
      // Never resolves — the stubbed dial emits no `ready` — so the timeout
      // rejection is the expected outcome and is consumed here rather than
      // surfacing as an unhandled rejection.
      await expect(handler.connect(channel, 4711)).rejects.toBeDefined();

      expect(connectCalls).toEqual([{ port: 4711, host: '127.0.0.1' }]);
   });

   /**
    * Regression guard for the `initialize`-hang race.
    * `SocketConnectionForwarder` subscribes to `channel.onMessage` in
    * its constructor, and Theia's `ForwardingChannel` emitter has no
    * pre-subscription replay — so without the buffer, a frontend write landing
    * before the forwarder is wired is dropped silently and the handshake hangs
    * with no error.
    *
    * These cover the replay half specifically because it is the fragile half:
    * it re-fires on `AbstractChannel.onMessageEmitter`, which is `protected`
    * upstream and reached via cast. A Theia rename degrades to warn-and-drop,
    * which reinstates that hang and its silence. Without these assertions
    * nothing in the suite would notice.
    */
   describe('pre-forward buffer replay', () => {
      const makeHandler = (): { handler: TestHandler; logger: ILogger } => {
         const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
         const handler = new TestHandler(baseOptions());
         (handler as unknown as { logger: ILogger }).logger = logger;
         return { handler, logger };
      };

      const makeChannel = (): ForwardingChannel =>
         new ForwardingChannel(
            'test',
            () => {},
            () => {
               throw new Error('write buffer not needed for these tests');
            }
         );

      it('delivers a message buffered BEFORE the forwarder subscribed', () => {
         const { handler } = makeHandler();
         const channel = makeChannel();
         const provider = (() => 'payload') as unknown as MessageProvider;

         // The forwarder subscribes only now — after the message already arrived.
         const received: MessageProvider[] = [];
         channel.onMessage(incoming => received.push(incoming));
         handler.replay(channel, [provider]);

         expect(received).toEqual([provider]);
      });

      it('replays in arrival order', () => {
         const { handler } = makeHandler();
         const channel = makeChannel();
         const providers = ['first', 'second', 'third'].map(payload => (() => payload) as unknown as MessageProvider);

         const received: string[] = [];
         channel.onMessage(incoming => received.push(incoming() as unknown as string));
         handler.replay(channel, providers);

         expect(received).toEqual(['first', 'second', 'third']);
      });

      it('leaves the read position alone, so a replayed provider yields the same bytes', () => {
         const { handler } = makeHandler();
         const channel = makeChannel();
         // MessageProvider is a thunk; buffering must not consume it. Calling it
         // twice has to produce equal payloads or replay would deliver garbage.
         const provider = (() => ({ bytes: [1, 2, 3] })) as unknown as MessageProvider;

         const received: MessageProvider[] = [];
         channel.onMessage(incoming => received.push(incoming));
         handler.replay(channel, [provider]);

         expect(received[0]()).toEqual(provider());
      });

      it('warns and drops rather than throwing when the channel is not a ForwardingChannel', () => {
         const { handler, logger } = makeHandler();
         const foreign = { onMessage: () => Disposable.create(() => {}) } as unknown as Channel;

         expect(() => handler.replay(foreign, [(() => 'payload') as unknown as MessageProvider])).not.toThrow();
         expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not a ForwardingChannel'));
      });

      it('warns and drops when Theia renames onMessageEmitter out from under the cast', () => {
         const { handler, logger } = makeHandler();
         const channel = makeChannel();
         // Simulate the upstream rename this workaround is exposed to.
         delete (channel as unknown as Record<string, unknown>).onMessageEmitter;

         expect(() => handler.replay(channel, [(() => 'payload') as unknown as MessageProvider])).not.toThrow();
         expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onMessageEmitter not accessible'));
      });
   });
});
