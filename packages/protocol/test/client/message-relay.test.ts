/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The host half of the clone hop, tested in the package that ships it.
 *
 * Two tiers, and the second is not redundant. Over a recorded transport the
 * relay's ORDER and lifecycle are directly assertable, which is what the
 * connect-window race needs. Over a real listening socket the framed side does
 * its own `Content-Length` coding, so a message large enough to span TCP
 * segments exercises reassembly across chunk boundaries — something a duplex
 * pair in one process cannot produce.
 */

import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from 'vscode-jsonrpc';
import { SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import {
   RELAY_TRANSPORT_OPEN_FAILED,
   RELAY_TRANSPORT_READ_FAILED,
   RELAY_TRANSPORT_WRITE_FAILED,
   relayToPostMessageChannel,
   type MessageRelay,
   type RelayTransport
} from '../../src/client';
import type { ResolvedMessage } from '../../src/messages/primitives';
import { tick, waitFor } from '../../src/testing';
import { ClonePipeEnd, RecordingTransport, methodsOf, notification } from './clone-pipe';

interface Failure {
   readonly error: unknown;
   readonly message: ResolvedMessage;
}

const toDispose: Array<{ dispose(): void }> = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

/** A channel, a framed stand-in and the relay between them, all torn down after the test. */
function setUp(options: { open?: () => Promise<RelayTransport> } = {}): {
   channel: ClonePipeEnd;
   transport: RecordingTransport;
   relay: MessageRelay;
   failures: Failure[];
} {
   const channel = new ClonePipeEnd();
   const transport = new RecordingTransport();
   const failures: Failure[] = [];
   const relay = relayToPostMessageChannel(channel, options.open ?? (() => Promise.resolve(transport)), {
      reportError: (error, message) => failures.push({ error, message })
   });
   toDispose.push(relay, channel);
   return { channel, transport, relay, failures };
}

describe('relayToPostMessageChannel', () => {
   it('replays messages sent during the connect window, in order', async () => {
      // The subscription the relay takes before its first await is what makes
      // this possible at all: `PostMessageChannel.onMessage` has no replay, so a
      // message sent while the transport is opening is otherwise dropped.
      let release = (): void => undefined;
      const gate = new Promise<void>(resolve => (release = resolve));
      const transport = new RecordingTransport();
      const channel = new ClonePipeEnd();
      const relay = relayToPostMessageChannel(channel, async () => {
         await gate;
         return transport;
      });
      toDispose.push(relay, channel);

      channel.deliver(notification('ns/one', 1));
      channel.deliver(notification('ns/two', 2));
      channel.deliver(notification('ns/three', 3));
      expect(transport.writer.written).toEqual([]);

      release();
      await expect(relay.wired).resolves.toBe(true);
      await tick();

      // The sequence, not the set: a replay in the wrong order would satisfy a
      // membership assertion.
      expect(methodsOf(transport.writer.written)).toEqual(['ns/one', 'ns/two', 'ns/three']);
   });

   it('keeps pumping the channel after the hand-off', async () => {
      const { channel, transport, relay } = setUp();
      await expect(relay.wired).resolves.toBe(true);

      channel.deliver(notification('ns/after'));
      await tick();

      expect(methodsOf(transport.writer.written)).toEqual(['ns/after']);
   });

   it('posts what the framed side emits onto the channel', async () => {
      const { channel, transport, relay } = setUp();
      await expect(relay.wired).resolves.toBe(true);

      transport.reader.emit(notification('ns/inbound', 7));
      await tick();

      expect(channel.posted).toEqual([notification('ns/inbound', 7)]);
   });

   it('reports and closes when opening the transport fails', async () => {
      const boom = new Error('no port');
      const { relay, failures } = setUp({ open: () => Promise.reject(boom) });
      let closes = 0;
      relay.onClose(() => (closes += 1));

      await expect(relay.wired).resolves.toBe(false);

      // Keyed on the CODE, which is the contract; the English default is a
      // fallback and may be reworded. `params` is asserted too, because a
      // renderer given a translation reads the sentence out of those rather
      // than out of `text` — a code that arrived with no `detail` would render
      // correctly in English and lose the cause in every other language.
      expect(failures.map(failure => failure.error)).toEqual([boom]);
      expect(failures.map(failure => failure.message.code)).toEqual([RELAY_TRANSPORT_OPEN_FAILED.code]);
      expect(failures[0].message.params).toEqual({ detail: 'no port' });
      expect(closes).toBe(1);
   });

   it('surfaces the framed side going away as onClose', async () => {
      const { transport, relay } = setUp();
      await expect(relay.wired).resolves.toBe(true);
      let closes = 0;
      relay.onClose(() => (closes += 1));

      transport.reader.raiseClose();

      expect(closes).toBe(1);
   });

   it('reports a framed-side read error and closes', async () => {
      const { transport, relay, failures } = setUp();
      await expect(relay.wired).resolves.toBe(true);
      let closes = 0;
      relay.onClose(() => (closes += 1));

      const boom = new Error('socket reset');
      transport.reader.raiseError(boom);

      expect(failures.map(failure => failure.error)).toEqual([boom]);
      expect(failures.map(failure => failure.message.code)).toEqual([RELAY_TRANSPORT_READ_FAILED.code]);
      expect(failures[0].message.params).toEqual({ detail: 'socket reset' });
      expect(closes).toBe(1);
   });

   it('reports a failed write without tearing the relay down', async () => {
      const { channel, transport, relay, failures } = setUp();
      await expect(relay.wired).resolves.toBe(true);

      transport.writer.failWith = new Error('write after end');
      channel.deliver(notification('ns/doomed'));
      await waitFor(() => failures.length === 1, { message: 'the write rejection was swallowed' });

      expect(failures[0].message.code).toBe(RELAY_TRANSPORT_WRITE_FAILED.code);
      expect(failures[0].message.params).toEqual({ detail: 'write after end' });
   });

   it('releases a transport that opened after the relay was disposed', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>(resolve => (release = resolve));
      const transport = new RecordingTransport();
      const channel = new ClonePipeEnd();
      const relay = relayToPostMessageChannel(channel, async () => {
         await gate;
         return transport;
      });
      toDispose.push(channel);

      relay.dispose();
      release();

      // Nobody else can: the relay owns the transport from the moment
      // `openTransport` resolves, so a socket that arrives late outlives the
      // relay unless the relay releases it.
      await expect(relay.wired).resolves.toBe(false);
      expect(transport.disposals).toBe(1);
   });

   it('stops pumping both directions once disposed', async () => {
      const { channel, transport, relay } = setUp();
      await expect(relay.wired).resolves.toBe(true);

      relay.dispose();
      channel.deliver(notification('ns/late'));
      await tick();

      expect(transport.writer.written).toEqual([]);
      expect(channel.posted).toEqual([]);
   });

   it('disposes itself when the channel closes', async () => {
      const { channel, transport, relay } = setUp();
      await expect(relay.wired).resolves.toBe(true);

      channel.fireClose();

      expect(transport.disposals).toBe(1);
   });
});

/**
 * A relay whose framed side is a real listening socket.
 *
 * `SocketMessageReader` / `SocketMessageWriter` do the `Content-Length` coding
 * the relay deliberately knows nothing about, and the payload below is far
 * larger than one TCP segment — so a message only arrives if reassembly across
 * chunk boundaries works. A duplex pair in one process would deliver it whole
 * and prove nothing about that.
 */
describe('relayToPostMessageChannel over a real socket', () => {
   const BULK = 'x'.repeat(256 * 1024);

   it('carries a segment-spanning message in both directions', async () => {
      const serverInbound: Message[] = [];
      let serverWriter: SocketMessageWriter | undefined;

      const server = net.createServer(socket => {
         const reader = new SocketMessageReader(socket);
         reader.listen(message => serverInbound.push(message));
         serverWriter = new SocketMessageWriter(socket);
      });
      toDispose.push({ dispose: () => server.close() });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
         throw new Error('the test server did not bind a TCP port');
      }

      const channel = new ClonePipeEnd();
      const relay = relayToPostMessageChannel(channel, async () => {
         const socket = await new Promise<net.Socket>((resolve, reject) => {
            const pending = net.connect(address.port, '127.0.0.1', () => resolve(pending));
            pending.on('error', reject);
         });
         return {
            reader: new SocketMessageReader(socket),
            writer: new SocketMessageWriter(socket),
            dispose: () => socket.destroy()
         };
      });
      toDispose.push(relay, channel);
      await expect(relay.wired).resolves.toBe(true);

      channel.deliver(notification('ns/outbound', BULK));
      await waitFor(() => serverInbound.length === 1, { message: 'nothing reached the socket server' });
      expect(serverInbound[0]).toEqual(notification('ns/outbound', BULK));

      await waitFor(() => serverWriter !== undefined, { message: 'the socket server never accepted a connection' });
      if (serverWriter === undefined) {
         throw new Error('the socket server never accepted a connection');
      }
      await serverWriter.write(notification('ns/inbound', BULK));
      await waitFor(() => channel.posted.length === 1, { message: 'nothing came back onto the channel' });
      expect(channel.posted[0]).toEqual(notification('ns/inbound', BULK));
   });
});
