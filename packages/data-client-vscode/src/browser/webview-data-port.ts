/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   createPostMessageTransport,
   renderFrameworkMessage,
   type DataPort,
   type Logger,
   type PostMessageChannel,
   type ResolvedMessage
} from '@hydranium/protocol';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/browser';

/** Options for {@link WebviewDataPort}. */
export interface WebviewDataPortOptions {
   /**
    * Surface a data-head failure. Without one it goes to the webview's console;
    * a webview whose extension shows notifications forwards it there instead.
    */
   readonly reportError?: (error: unknown, reported: ResolvedMessage) => void;
   /** Where the connection logs its protocol faults, and what it does on its own. */
   readonly logger?: Logger;
}

/**
 * The webview's {@link DataPort}: the sandbox side of the data head, over the
 * extension host's messenger hop.
 *
 * `vscode-jsonrpc/browser`, not the package root, which installs no runtime
 * abstraction layer and throws on the first message rather than at wire-up.
 */
export class WebviewDataPort implements DataPort {
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;
   readonly logger?: Logger;
   protected disposed = false;
   /** The connection every generation gets until it is disposed. */
   protected connection?: MessageConnection;

   constructor(
      protected readonly channel: PostMessageChannel,
      protected readonly options: WebviewDataPortOptions = {}
   ) {
      this.logger = options.logger;
   }

   /**
    * Hand back a listening connection over the hop: the same one until it is
    * disposed, and then a fresh transport, so a disposed connection leaves no
    * second reader on the pipe.
    *
    * Every connection reaches the one relay behind the pipe, and each numbers
    * its requests from zero, so a second live one would take answers meant for
    * the first. A retry after a failed readiness check therefore gets the
    * connection the check used.
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
      if (this.options.reportError) {
         this.options.reportError(error, reported);
      } else {
         console.error(`[data head] ${renderFrameworkMessage(reported)}`, error);
      }
   }

   /**
    * The extension host reports the relay's framed side died.
    *
    * A `PostMessageChannel` has no `close()`, so the pipe still looks open from
    * here: firing `onDispose` makes `DataConnection` drop its generation, and
    * disposing the connection rejects everything in flight, also when no
    * generation holds it. The connection is forgotten before the event, so a
    * listener that connects gets a fresh one rather than the one about to be
    * disposed.
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
