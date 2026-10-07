/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, SystemClock } from '@hydranium/protocol';
import { type Channel, Disposable, DisposableCollection, type MessageProvider } from '@theia/core';
import type * as net from 'node:net';
import {
   createMessageConnection,
   type Message,
   type MessageConnection,
   SocketMessageReader,
   SocketMessageWriter
} from 'vscode-jsonrpc/node';

/**
 * Relays JSON-RPC messages between a Theia browser-frontend {@link Channel} and
 * a server's TCP socket — the backend half of a head's transport. The server
 * speaks vscode-jsonrpc (Content-Length framed) on the socket; the frontend
 * speaks the same protocol over the channel. This forwarder decodes each side
 * and re-emits on the other.
 *
 * Behaves as `@eclipse-glsp/theia-integration`'s `SocketConnectionForwarder`
 * does, and both heads use it, except that when the channel closes, the writes
 * still queued go out before the socket ends. A page going away sends its last
 * messages and closes its channel in the same tick, and the writer takes
 * several turns per message, so destroying the socket on the close loses them.
 */
export class SocketChannelForwarder implements Disposable {
   protected readonly toDispose = new DisposableCollection();
   /** The last write to the socket; the writer runs its writes one at a time, so this settles last. */
   protected lastWrite: Promise<void> = Promise.resolve();
   /**
    * How long {@link endSocket} waits for the queued writes before it destroys
    * the socket anyway. Without a bound, a server that stops reading holds the
    * socket open for good, and with it the server's end of the connection.
    */
   protected readonly flushTimeoutMs: number = 10_000;

   constructor(
      protected readonly channel: Channel,
      protected readonly socket: net.Socket,
      /** Times {@link flushTimeoutMs}. */
      protected readonly clock: Clock = new SystemClock()
   ) {
      const reader = new SocketMessageReader(socket);
      const writer = new SocketMessageWriter(socket);
      // Never listens, so it handles no message and has nothing to log.
      // ast-grep-ignore: connection-without-logger
      const connection = createMessageConnection(reader, writer);
      // Nothing here destroys the socket directly. `SocketMessageWriter.dispose()`
      // destroys it itself, which covers both `dispose` and `endSocket`; and
      // `connection.onClose` fires only from the reader's or writer's own close,
      // which for a socket means the socket has already gone — so a destroy
      // handler there is downstream of the effect it would be trying to cause.
      this.toDispose.pushAll([
         reader.listen(message => this.writeToChannel(message)),
         channel.onMessage(provider => {
            // A failed write means the socket is gone, which its own close reports.
            this.lastWrite = writer.write(this.decodeChannelMessage(provider)).catch(() => undefined);
         }),
         channel.onClose(() => void this.endSocket(connection)),
         connection.onClose(() => channel.close()),
         Disposable.create(() => {
            channel.close();
            connection.dispose();
         })
      ]);
   }

   /**
    * Dispose `connection`, which destroys the socket, once the writes queued
    * before the channel closed are out, or {@link flushTimeoutMs} has passed. A
    * write has settled once the socket handed its bytes to the OS, and
    * destroying the socket then loses nothing.
    */
   protected async endSocket(connection: MessageConnection): Promise<void> {
      await this.clock.raceTimer(this.lastWrite, this.flushTimeoutMs);
      connection.dispose();
   }

   protected decodeChannelMessage(provider: MessageProvider): Message {
      const buffer = provider().readBytes();
      return JSON.parse(new TextDecoder().decode(buffer)) as Message;
   }

   protected writeToChannel(message: Message): void {
      const writeBuffer = this.channel.getWriteBuffer();
      writeBuffer.writeBytes(new TextEncoder().encode(JSON.stringify(message)));
      writeBuffer.commit();
   }

   dispose(): void {
      this.toDispose.dispose();
   }
}
