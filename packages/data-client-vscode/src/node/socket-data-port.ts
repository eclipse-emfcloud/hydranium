/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { renderFrameworkMessage, type DataPort, type Logger, type ResolvedMessage } from '@hydranium/protocol';
import { Emitter } from 'vscode-jsonrpc';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { openSocketTransport } from './data-server-connection';

/** What {@link SocketDataPort} needs from the host. */
export interface SocketDataPortOptions {
   /**
    * Resolve the data-server's listening port. Called once per connection
    * generation, so a restarted server is re-discovered rather than cached.
    */
   readonly findPort: () => Promise<number>;
   /** The data-server's host. Defaults to the loopback address. */
   readonly host?: string;
   /** Where the connection logs its protocol faults, and what it does on its own. */
   readonly logger?: Logger;
   /** Surface a failure to the user. Defaults to the logger, else the console. */
   readonly reportError?: (error: unknown, reported: ResolvedMessage) => void;
}

/**
 * A {@link DataPort} over a socket to the data-server, for code in the
 * extension host itself, such as a command. A webview has no `net`; it takes
 * `WebviewDataPort` over `connectDataServer` instead.
 *
 * Each generation opens its own socket and closes the one before, without
 * firing {@link onDispose} for it; of two overlapping calls, the one that
 * settles last keeps its socket. A socket the server ends under the current
 * generation fires it, so `DataConnection` reconnects to the port
 * {@link SocketDataPortOptions.findPort} finds next.
 */
export class SocketDataPort implements DataPort {
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose = this.disposeEmitter.event;
   readonly logger?: Logger;
   protected disposed = false;
   protected current?: { readonly connection: MessageConnection; readonly dispose: () => void };

   constructor(protected readonly options: SocketDataPortOptions) {
      this.logger = options.logger;
   }

   async connect(): Promise<MessageConnection> {
      if (this.disposed) {
         throw new Error('SocketDataPort: the port is disposed');
      }
      const transport = await openSocketTransport(await this.options.findPort(), this.options.host);
      // Disposed while the socket opened: nothing would close this one.
      if (this.disposed) {
         transport.dispose?.();
         throw new Error('SocketDataPort: the port is disposed');
      }
      // The one before, or an overlapping call's that was installed meanwhile.
      this.closeCurrent();
      const connection = createMessageConnection(transport.reader, transport.writer, this.logger);
      const current = {
         connection,
         dispose: () => {
            connection.dispose();
            transport.dispose?.();
         }
      };
      this.current = current;
      connection.onClose(() => {
         if (this.current === current) {
            this.closeCurrent();
            this.disposeEmitter.fire();
         }
      });
      connection.listen();
      return connection;
   }

   reportError(error: unknown, reported: ResolvedMessage): void {
      if (this.options.reportError) {
         this.options.reportError(error, reported);
      } else if (this.logger) {
         this.logger.error(renderFrameworkMessage(reported), error);
      } else {
         console.error(`[data head] ${renderFrameworkMessage(reported)}`, error);
      }
   }

   /** The consumer hears it first; then the current socket closes. */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.closeCurrent();
   }

   protected closeCurrent(): void {
      const current = this.current;
      this.current = undefined;
      current?.dispose();
   }
}
