/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The webview's {@link DataPort} — the sandbox side of the data head.
 *
 * All four members are here and nothing else, because that is the whole port:
 * `DataConnection` owns the readiness gate, the reconnect policy and the typed
 * proxy above it, and `createRpcProxy` runs unchanged over whatever connection
 * this hands back. The point of the interface is that this file has no idea it is
 * talking to a socket two processes away.
 *
 * Browser-side by construction: `vscode-jsonrpc/browser`, not the package root,
 * which installs no runtime abstraction layer and throws
 * `No runtime abstraction layer installed` on the first message rather than at
 * wire-up.
 */

import { createPostMessageTransport, type Logger, type PostMessageChannel, type ResolvedMessage } from '@hydranium/protocol';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/browser';

/**
 * A `DataPort` over the extension↔webview hop.
 *
 * Not declared `implements DataPort`: the webview entry point asserts the
 * conformance instead, so a drift in the framework's port shape surfaces at
 * compile time rather than on the first message.
 */
export class WebviewDataPort {
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;
   protected disposed = false;
   /** The connection every generation gets until it is disposed. */
   protected connection?: MessageConnection;

   constructor(
      protected readonly channel: PostMessageChannel,
      protected readonly report: (error: unknown, reported: ResolvedMessage) => void,
      /** Where the connection logs its protocol faults, and what it does on its own. */
      readonly logger: Logger
   ) {}

   /**
    * Hand back a listening connection over the hop: the same one until it is
    * disposed, and then a fresh transport, so a disposed connection leaves no
    * second reader on the pipe.
    *
    * Every connection reaches the one relay behind the pipe, and each numbers
    * its requests from zero, so a second live one would take answers meant for
    * the first. A retry after a failed readiness check therefore gets the
    * connection the check used. Returned already listening, as the port
    * contract requires — the proxy queues calls on this promise but never
    * calls `listen` itself.
    */
   async connect(): Promise<MessageConnection> {
      if (this.disposed) {
         throw new Error('WebviewDataPort: the port is disposed');
      }
      if (!this.connection) {
         const transport = createPostMessageTransport(this.channel);
         const connection = createMessageConnection(transport.reader, transport.writer, this.logger);
         connection.onDispose(() => {
            transport.dispose();
            if (this.connection === connection) {
               this.connection = undefined;
            }
         });
         connection.listen();
         this.connection = connection;
      }
      return this.connection;
   }

   reportError(error: unknown, reported: ResolvedMessage): void {
      this.report(error, reported);
   }

   /**
    * The host told us the relay's framed side died.
    *
    * Firing `onDispose` is what makes `DataConnection` drop its generation,
    * and disposing the connection rejects everything in flight, also when no
    * generation holds it, as after a failed readiness check. Without both the
    * webview would sit on requests that can never be answered — a
    * `PostMessageChannel` has no `close()`, so the pipe still looks open from
    * here. The connection is forgotten before the event, so a listener that
    * connects gets a fresh one rather than the one about to be disposed.
    */
   connectionLost(): void {
      const lost = this.connection;
      this.connection = undefined;
      this.disposeEmitter.fire();
      lost?.dispose();
   }

   /** Refuses to connect afterwards: the consumer's reconnect would otherwise open a reader nothing releases. */
   dispose(): void {
      this.disposed = true;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.connection?.dispose();
   }
}
