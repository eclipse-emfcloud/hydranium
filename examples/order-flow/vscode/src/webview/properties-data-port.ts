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
 * `DataSession` owns the readiness gate, the reconnect policy and the typed
 * proxy above it, and `createRpcProxy` runs unchanged over whatever connection
 * this hands back. The point of the interface is that this file has no idea it is
 * talking to a socket two processes away.
 *
 * Browser-side by construction: `vscode-jsonrpc/browser`, not the package root,
 * which installs no runtime abstraction layer and throws
 * `No runtime abstraction layer installed` on the first message rather than at
 * wire-up.
 */

import { createPostMessageTransport, type PostMessageChannel } from '@hydranium/protocol';
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
   /**
    * Stable for the session, because it is the echo key — a client that cannot
    * recognise its own `sourceClientId` treats its own write as a concurrent
    * third-party one. Distinct from the framework's own well-known client ids,
    * which `DataPort.clientId` lists.
    */
   readonly clientId = 'order-flow-properties-webview';

   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;

   constructor(
      protected readonly channel: PostMessageChannel,
      protected readonly report: (error: unknown, context: string) => void
   ) {}

   /**
    * Build a listening connection over the hop.
    *
    * A fresh transport per generation, so a dropped generation releases its
    * channel subscriptions instead of leaving a second reader on the same pipe.
    * Returned already listening, as the port contract requires — the proxy
    * queues calls on this promise but never calls `listen` itself.
    */
   async connect(): Promise<MessageConnection> {
      const transport = createPostMessageTransport(this.channel);
      const connection = createMessageConnection(transport.reader, transport.writer);
      connection.onDispose(() => transport.dispose());
      connection.listen();
      return connection;
   }

   reportError(error: unknown, context: string): void {
      this.report(error, context);
   }

   /**
    * The host told us the relay's framed side died.
    *
    * Firing `onDispose` is what makes `DataSession` drop its generation and
    * dispose the connection, which rejects everything in flight. Without it the
    * webview would sit on requests that can never be answered — a
    * `PostMessageChannel` has no `close()`, so the pipe still looks open from
    * here.
    */
   connectionLost(): void {
      this.disposeEmitter.fire();
   }

   dispose(): void {
      this.disposeEmitter.dispose();
   }
}
