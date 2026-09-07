/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A real `DataServer` behind a real listening socket, plus the client end of it
 * as a relay's framed side.
 *
 * **A real socket, deliberately, not a duplex stream pair.** Content-Length
 * framing is part of what these suites test, and only a real socket delivers
 * headers split across arbitrary chunk boundaries. A stream pair exercises the
 * same reader class with friendlier timing and can pass while a chunk-boundary
 * bug remains.
 *
 * Node-side test support: `vscode-jsonrpc/node` here, because this runs in Node
 * and holds a socket. The webview half of a real hop imports `/browser`; the
 * package ROOT installs no runtime abstraction layer and throws on first use.
 */

import { DataServer } from '@hydranium/data-server';
import type { RelayTransport } from '@hydranium/protocol';
import type { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-transfer/transfer-model';
import * as net from 'node:net';
import { SocketMessageReader, SocketMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

/** The union of transfer roots the order-flow grammars produce. */
export type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;
export type OrderFlowShared = ReturnType<typeof createOrderFlowServices>['shared'];

/** A real data server behind a real listening socket — the extension host's view. */
export interface SocketDataServer {
   readonly port: number;
   /** Drop the peer socket the way a crashing server would. */
   killConnections(): void;
   dispose(): Promise<void>;
}

export async function startSocketDataServer(shared: OrderFlowShared): Promise<SocketDataServer> {
   const peers: net.Socket[] = [];
   const server = net.createServer(socket => {
      peers.push(socket);
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      // Bind the handlers BEFORE dispatch starts. `listen()` first would let a
      // client whose first request is already in flight — which is precisely
      // what the replay-buffer tests arrange — reach an unhandled method. The
      // framework's own launchers order it this way for the same reason.
      void new DataServer<OrderFlowTransferRoot>(connection, shared);
      connection.listen();
   });

   await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
   });

   const address = server.address();
   if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from a TCP server bound to port 0');
   }

   return {
      port: address.port,
      killConnections(): void {
         for (const peer of peers) {
            peer.destroy();
         }
      },
      dispose(): Promise<void> {
         for (const peer of peers) {
            peer.destroy();
         }
         peers.length = 0;
         return new Promise<void>(resolve => server.close(() => resolve()));
      }
   };
}

/** Connect to `port` and present it as the framed side of a relay. */
export function openSocketTransport(port: number): Promise<RelayTransport> {
   return new Promise<RelayTransport>((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('error', reject);
      socket.once('connect', () => {
         socket.removeAllListeners('error');
         resolve({
            reader: new SocketMessageReader(socket),
            writer: new SocketMessageWriter(socket),
            dispose: () => socket.destroy()
         });
      });
   });
}
