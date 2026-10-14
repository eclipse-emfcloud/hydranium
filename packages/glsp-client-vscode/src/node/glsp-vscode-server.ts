/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SocketGlspVscodeServer } from '@eclipse-glsp/vscode-integration';
import { sendByMethodName, type Logger } from '@hydranium/protocol';
import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';

/** What {@link HydraniumGlspVscodeServer} needs beyond the GLSP client identity. */
export interface HydraniumGlspVscodeServerOptions {
   readonly clientId: string;
   readonly clientName: string;
   /**
    * Resolve the GLSP head's listening port, typically `findPort` from
    * `@hydranium/client-vscode/node`. Called when the connection is opened, so
    * the poll runs at `start()` rather than during activation.
    */
   readonly findPort: () => Promise<number>;
   /** Where the connection to the head logs its protocol faults. */
   readonly logger: Logger;
}

/**
 * The GLSP head reached over its ephemeral socket, with the port discovered
 * rather than configured.
 *
 * `SocketGlspVscodeServer` takes a fixed `connectionOptions` at construction,
 * but the head's port is assigned when it binds and published as an LSP
 * request. Awaiting it in `activate` would block activation behind a poll that
 * can take seconds, even for a user who never opens a diagram, so the lookup
 * moves to `createConnection`, which the base class calls from `start()`.
 * The `connectionOptions` handed to `super` is never read, and is an unusable
 * port so that a refactor reintroducing the base implementation fails loudly
 * instead of dialling something.
 *
 * Report a failure off `onReady`, not off `start()`: `start()` routes its own
 * error into the readiness promise and resolves anyway.
 */
export class HydraniumGlspVscodeServer extends SocketGlspVscodeServer {
   protected readonly findPort: () => Promise<number>;
   protected readonly logger: Logger;

   constructor(options: HydraniumGlspVscodeServerOptions) {
      super({
         clientId: options.clientId,
         clientName: options.clientName,
         connectionOptions: { port: 0 }
      });
      this.findPort = options.findPort;
      this.logger = options.logger;
   }

   protected override async createConnection(): ReturnType<SocketGlspVscodeServer['createConnection']> {
      const port = await this.findPort();
      // `127.0.0.1`, not `localhost`, and it has to match the head: `startGlspServer`
      // binds `127.0.0.1` by default, so on a dual-stack machine where `localhost`
      // resolves to `::1` first the dial fails as ECONNREFUSED with nothing in the
      // message naming the address family as the cause.
      // Built here rather than by the base's `createSocketConnection`, which
      // passes no logger. GLSP's client sends typed messages built by
      // `@eclipse-glsp/protocol`'s copy of `vscode-jsonrpc`, so they go by name.
      const socket = new net.Socket();
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket), this.logger);
      socket.connect({ port, host: '127.0.0.1' });
      return sendByMethodName(connection);
   }
}
