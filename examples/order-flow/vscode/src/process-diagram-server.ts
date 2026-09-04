/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SocketGlspVscodeServer } from '@eclipse-glsp/vscode-integration';
import type { MessageConnection } from 'vscode-jsonrpc';

/** What {@link OrderFlowGlspVscodeServer} needs beyond the GLSP client identity. */
export interface OrderFlowGlspVscodeServerOptions {
   readonly clientId: string;
   readonly clientName: string;
   /**
    * Resolve the GLSP head's listening port. Called once, when the connection is
    * actually opened, so the poll runs at first diagram open rather than during
    * activation.
    */
   readonly findPort: () => Promise<number>;
}

/**
 * The GLSP head reached over its ephemeral socket, with the port discovered
 * rather than configured.
 *
 * `SocketGlspVscodeServer` takes a fixed `connectionOptions` at construction,
 * which does not fit this server: the port is assigned by the OS when the head
 * binds, and published as an LSP request the extension has to ask for. Awaiting
 * it in `activate` would work but would block activation behind a poll that can
 * legitimately take seconds, and would do so even for a user who never opens a
 * diagram.
 *
 * So the resolution moves to `createConnection`, which the base class calls from
 * `start()` — the point at which the port is genuinely needed. The
 * `connectionOptions` handed to `super` is therefore never read: this override
 * is the only path to a connection, and it computes its own. It is spelled as
 * an unusable port rather than a plausible one so that a future refactor
 * reintroducing the base implementation fails loudly instead of quietly dialling
 * something.
 *
 * The same lazy-discovery shape as the properties panel's `findPort`, and for
 * the same reason: a restarted language server binds a FRESH port, so a value
 * captured once at activation is wrong for the rest of the session.
 */
export class OrderFlowGlspVscodeServer extends SocketGlspVscodeServer {
   protected readonly findPort: () => Promise<number>;

   constructor(options: OrderFlowGlspVscodeServerOptions) {
      super({
         clientId: options.clientId,
         clientName: options.clientName,
         connectionOptions: { port: 0 }
      });
      this.findPort = options.findPort;
   }

   protected override async createConnection(): Promise<MessageConnection> {
      const port = await this.findPort();
      // `127.0.0.1`, not `localhost`, and it has to match the head: `startGlspServer`
      // binds `127.0.0.1` by default, so on a dual-stack machine where `localhost`
      // resolves to `::1` first the dial fails as ECONNREFUSED with nothing in the
      // message naming the address family as the cause.
      return this.createSocketConnection({ port, host: '127.0.0.1' });
   }
}
