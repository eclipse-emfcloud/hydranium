/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Channel, Disposable, DisposableCollection, type MessageProvider } from '@theia/core';
import type * as net from 'node:net';
import { createMessageConnection, type Message, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';

/**
 * Relays JSON-RPC messages between a Theia browser-frontend {@link Channel} and
 * a data-server's TCP socket — the backend half of the data-server head's
 * transport. The model-server speaks vscode-jsonrpc (Content-Length framed) on
 * the socket; the frontend speaks the same protocol over the channel (via
 * `createChannelConnection`). This forwarder decodes each side and re-emits on
 * the other, so the two ends share one protocol with no semantic re-proxy in
 * between.
 *
 * Framework-owned equivalent of `@eclipse-glsp/theia-integration`'s
 * `SocketConnectionForwarder` — reproduced here (rather than imported) so the
 * data-server head carries no GLSP dependency.
 */
export class SocketChannelForwarder implements Disposable {
   protected readonly toDispose = new DisposableCollection();

   constructor(
      protected readonly channel: Channel,
      protected readonly socket: net.Socket
   ) {
      const reader = new SocketMessageReader(socket);
      const writer = new SocketMessageWriter(socket);
      const connection = createMessageConnection(reader, writer);
      // Nothing here destroys the socket, and adding it back would be dead
      // code in both directions. `SocketMessageWriter.dispose()` destroys it
      // itself, which covers the dispose path; and `connection.onClose` fires
      // only from the reader's or writer's own close, which for a socket means
      // the socket has already gone — so a destroy handler there is downstream
      // of the effect it would be trying to cause.
      this.toDispose.pushAll([
         reader.listen(message => this.writeToChannel(message)),
         channel.onMessage(provider => void writer.write(this.decodeChannelMessage(provider))),
         channel.onClose(() => connection.dispose()),
         connection.onClose(() => channel.close()),
         Disposable.create(() => {
            channel.close();
            connection.dispose();
         })
      ]);
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
