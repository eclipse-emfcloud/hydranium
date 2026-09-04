/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataPort } from '@hydranium/protocol';
import {
   BrowserMessageReader,
   BrowserMessageWriter,
   createMessageConnection,
   Emitter,
   type MessageConnection
} from 'vscode-jsonrpc/browser';

/**
 * The host half of the data head for a page talking to a worker.
 *
 * The whole port is four members, and this is what a browser host has to write
 * to reach the data head — everything above it (the open/watch order,
 * `baseVersion` conflict handling, echo filtering by `sourceClientId`) is
 * host-invariant and already in `DataSession`.
 *
 * `vscode-jsonrpc/browser`, never the package root: version 9's root entry ships
 * no runtime abstraction layer and throws on the first message rather than at
 * import, so the mistake surfaces as a dead connection rather than a stack
 * trace.
 */
export class WorkerDataPort implements DataPort {
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose = this.disposeEmitter.event;

   constructor(
      readonly clientId: string,
      protected readonly port: MessagePort
   ) {}

   /**
    * The transport is the port the worker was already handed at bootstrap, so
    * there is nothing to open — but the connection must be `listen()`ing before
    * it is returned, because the RPC proxy queues calls on this promise and
    * never listens itself.
    */
   connect(): Promise<MessageConnection> {
      const connection = createMessageConnection(new BrowserMessageReader(this.port), new BrowserMessageWriter(this.port));
      connection.listen();
      return Promise.resolve(connection);
   }

   reportError(error: unknown, context: string): void {
      // The page has one status line and no notification surface, so failures
      // go to the console rather than being swallowed — an unreported data-head
      // error presents as an empty model, which reads as a valid document.
      console.error(`[data head] ${context}:`, error);
   }

   dispose(): void {
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
   }
}
