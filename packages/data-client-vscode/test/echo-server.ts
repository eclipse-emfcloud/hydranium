/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';

/** A socket server answering `echo` on every connection, standing in for the data-server. */
export interface EchoServer {
   readonly port: number;
   /** The connections accepted so far. */
   readonly accepted: () => number;
   /** The accepted sockets the client side has closed or the server dropped. */
   readonly closed: () => number;
   /** End every accepted socket, as a server that died would. */
   readonly dropConnections: () => void;
   readonly close: () => Promise<void>;
}

export async function startEchoServer(): Promise<EchoServer> {
   const sockets: net.Socket[] = [];
   let closed = 0;
   const server = net.createServer(socket => {
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      connection.onRequest('echo', (value: unknown) => value);
      connection.listen();
      socket.once('close', () => {
         closed++;
         connection.dispose();
      });
      sockets.push(socket);
   });
   await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
   const address = server.address() as net.AddressInfo;
   const dropConnections = (): void => sockets.forEach(socket => socket.destroy());
   return {
      port: address.port,
      accepted: () => sockets.length,
      closed: () => closed,
      dropConnections,
      close: () => {
         dropConnections();
         return new Promise<void>(resolve => server.close(() => resolve()));
      }
   };
}
