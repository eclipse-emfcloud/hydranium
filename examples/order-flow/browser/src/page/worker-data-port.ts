/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createMessagePortTransport, renderFrameworkMessage, type DataPort, type Logger, type ResolvedMessage } from '@hydranium/protocol';
import { createMessageConnection, Emitter, type MessageConnection } from 'vscode-jsonrpc/browser';

/**
 * The host half of the data head for a page talking to a worker.
 *
 * This is the whole of what a browser host has to write to reach the data head
 * — everything above it (the open/watch order, `baseVersion` conflict handling,
 * echo filtering by `sourceClientId`) is host-invariant and already in
 * `DataConnection` and `DataSession`.
 *
 * `vscode-jsonrpc/browser`, never the package root: version 9's root entry ships
 * no runtime abstraction layer and throws on the first message rather than at
 * import, so the mistake surfaces as a dead connection rather than a stack
 * trace.
 */
export class WorkerDataPort implements DataPort {
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose = this.disposeEmitter.event;
   protected disposed = false;
   protected connection?: MessageConnection;

   constructor(
      protected readonly port: MessagePort,
      /** Where the connection logs its protocol faults, and what it does on its own. */
      readonly logger: Logger
   ) {}

   /**
    * The transport is the port the worker was already handed at bootstrap, so
    * there is nothing to open — but the connection must be `listen()`ing before
    * it is returned, because the RPC proxy queues calls on this promise and
    * never listens itself.
    *
    * Both ends use `createMessagePortTransport`; see it for why.
    *
    * Every generation gets the same connection. A fresh one per generation
    * would leave the one a failed readiness check used still reading the port,
    * and disposing that one is no way out: disposing any connection over the
    * port ends the worker's head, and the retry would wait for an answer that
    * never comes.
    *
    * **Rejects once this port is disposed, and a disposed port cannot be
    * reused.** Its dispose disposes the connection, which signals the close to
    * the worker, whose end of the port then stays closed: a later connection
    * over it would send requests nothing answers, and hang.
    */
   connect(): Promise<MessageConnection> {
      if (this.disposed) {
         return Promise.reject(new Error('WorkerDataPort: the port is disposed, and the data head behind it has ended'));
      }
      if (!this.connection) {
         const transport = createMessagePortTransport(this.port);
         this.connection = createMessageConnection(transport.reader, transport.writer, this.logger);
         this.connection.listen();
      }
      return Promise.resolve(this.connection);
   }

   reportError(error: unknown, reported: ResolvedMessage): void {
      // The page has one status line and no notification surface, so failures
      // go to the console rather than being swallowed — an unreported data-head
      // error presents as an empty model, which reads as a valid document.
      //
      // No translation map: this host ships no catalogue, and omitting the
      // argument is how an adopter without i18n opts out and takes the English.
      // The raw error goes alongside rather than into the sentence, because
      // `reported` already carries the detail and only the throw carries a stack.
      console.error(`[data head] ${renderFrameworkMessage(reported)}`, error);
   }

   /** The consumer hears it first; the connection goes even when no generation holds it, as after a failed readiness check. */
   dispose(): void {
      this.disposed = true;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.connection?.dispose();
   }
}
