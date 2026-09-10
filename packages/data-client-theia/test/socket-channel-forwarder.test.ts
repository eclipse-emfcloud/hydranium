/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { type Channel, type ChannelCloseEvent, Emitter, type MessageProvider, type WriteBuffer } from '@theia/core';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import * as net from 'node:net';
import { type Message, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import { SocketChannelForwarder } from '../src/node/socket-channel-forwarder';

/**
 * A Theia `Channel` that records rather than forwards.
 *
 * Purpose-built instead of `@theia/core`'s channel PIPE, because what these
 * cases need is observation — the bytes committed, and how many times `close`
 * was called — and a pipe only offers the far end. The close COUNT is the
 * point: the forwarder registers two `connection.onClose` handlers plus a
 * disposable that closes both sides itself, so "disposing closes the channel"
 * and "disposing closes the channel once" are different claims and only the
 * second rules out a cascade.
 */
class RecordingChannel implements Channel {
   readonly onMessageEmitter = new Emitter<MessageProvider>();
   readonly onErrorEmitter = new Emitter<unknown>();
   readonly onCloseEmitter = new Emitter<ChannelCloseEvent>();
   readonly onMessage = this.onMessageEmitter.event;
   readonly onError = this.onErrorEmitter.event;
   readonly onClose = this.onCloseEmitter.event;

   /** Every payload committed to a write buffer, decoded back to a string. */
   readonly written: string[] = [];
   closeCalls = 0;

   getWriteBuffer(): WriteBuffer {
      const buffer = new Uint8ArrayWriteBuffer();
      buffer.onCommit(committed => {
         this.written.push(new TextDecoder().decode(new Uint8ArrayReadBuffer(committed).readBytes()));
      });
      return buffer;
   }

   close(): void {
      this.closeCalls++;
      this.onCloseEmitter.fire({ reason: 'closed by test' });
   }

   /** Deliver one message to the channel's consumer, framed as Theia frames it. */
   deliver(message: Message): void {
      const buffer = new Uint8ArrayWriteBuffer();
      buffer.onCommit(committed => this.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(committed)));
      buffer.writeBytes(new TextEncoder().encode(JSON.stringify(message)));
      buffer.commit();
   }
}

/** A connected pair of real sockets on the loopback interface. */
async function socketPair(): Promise<{ near: net.Socket; far: net.Socket; server: net.Server }> {
   const server = net.createServer();
   await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
   const { port } = server.address() as net.AddressInfo;
   const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
   const near = net.connect(port, '127.0.0.1');
   await new Promise<void>(resolve => near.once('connect', () => resolve()));
   return { near, far: await accepted, server };
}

/** Resolve once `predicate` holds, so a case never outlives a lost message. */
async function until(predicate: () => boolean, what: string): Promise<void> {
   const deadline = Date.now() + 2_000;
   while (!predicate()) {
      if (Date.now() > deadline) {
         throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
   }
}

const REQUEST: Message = { jsonrpc: '2.0', id: 1, method: 'ns/one', params: { value: 'a' } } as Message;

describe('SocketChannelForwarder', () => {
   const cleanup: Array<() => void> = [];

   afterEach(() => {
      for (const dispose of cleanup.splice(0)) {
         dispose();
      }
   });

   async function forwarder(): Promise<{
      channel: RecordingChannel;
      near: net.Socket;
      far: net.Socket;
      subject: SocketChannelForwarder;
   }> {
      const { near, far, server } = await socketPair();
      const channel = new RecordingChannel();
      const subject = new SocketChannelForwarder(channel, near);
      cleanup.push(() => {
         far.destroy();
         near.destroy();
         server.close();
      });
      return { channel, near, far, subject };
   }

   it('re-frames a channel message onto the socket as JSON-RPC', async () => {
      // The two sides speak the same protocol over different framings — the
      // socket is Content-Length delimited, the channel length-prefixed — so a
      // real reader on the far end is what proves the framing, not the bytes.
      const { channel, far } = await forwarder();
      const received: Message[] = [];
      const reader = new SocketMessageReader(far);
      reader.listen(message => received.push(message));

      channel.deliver(REQUEST);

      await until(() => received.length > 0, 'the socket to receive the channel message');
      expect(received[0]).toEqual(REQUEST);
   });

   it('re-frames a socket message onto the channel', async () => {
      const { channel, far } = await forwarder();
      const writer = new SocketMessageWriter(far);

      await writer.write(REQUEST);

      await until(() => channel.written.length > 0, 'the channel to receive the socket message');
      expect(JSON.parse(channel.written[0])).toEqual(REQUEST);
   });

   it('does not close the channel twice when disposed', async () => {
      // What holds this is UPSTREAM, and that is why it is pinned here rather
      // than assumed: vscode-jsonrpc's `dispose()` fires its dispose emitter
      // and NOT its close emitter, so the disposable that closes both sides
      // cannot re-enter through `connection.onClose`. Were a future version to
      // merge the two, the graph would close the channel a second time and
      // every Theia `onClose` listener would run twice — silently, since a
      // second close throws nothing. The jsonrpc version is pinned as part of
      // an atomic chain, so a bump is exactly when this would change.
      const { channel, subject } = await forwarder();

      subject.dispose();

      expect(channel.closeCalls).toBe(1);
   });

   it('leaves no socket open when the channel closes', async () => {
      // The data-server holds a session per connection, so a leaked socket is
      // a leaked model store. What closes it is UPSTREAM — `connection.dispose()`
      // disposes the writer, and `SocketMessageWriter.dispose()` destroys the
      // socket itself — so this pins the outcome the head depends on across a
      // jsonrpc bump, not a line in this file.
      const { channel, near } = await forwarder();

      channel.close();

      await until(() => near.destroyed, 'the socket to be destroyed after the channel closed');
   });

   it('closes the channel when the socket end goes away', async () => {
      // The other direction, and the one an adopter sees as a hung frontend:
      // a data-server that dies leaves the channel open forever unless the
      // connection's close is propagated back.
      const { channel, far } = await forwarder();

      far.destroy();

      await until(() => channel.closeCalls > 0, 'the channel to close after the socket went away');
   });
});
