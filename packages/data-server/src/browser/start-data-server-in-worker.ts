/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createMessagePortTransport, type TransferredMessagePort } from '@hydranium/protocol';
import type { ServerSharedServicesMinimal } from '@hydranium/core';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';

/**
 * Start the data head on the port the page transferred for it, on the same
 * shared tier the LSP head runs on, and return the server `create` built.
 *
 * `create` constructs the adopter's `DataServer`, or a subclass of it, around
 * the connection, as a Node host's socket callback does, and the connection
 * listens once it has returned, in the order the Node launcher uses. The
 * page's end of the port closing disposes the server, which ends every
 * session this connection registered.
 */
export function startDataServerInWorker<TServer>(
   port: TransferredMessagePort,
   shared: Pick<ServerSharedServicesMinimal, 'Logger'>,
   create: (connection: MessageConnection) => TServer
): TServer {
   // Both ends use `createMessagePortTransport`; see it for why.
   const transport = createMessagePortTransport(port);
   const connection = createMessageConnection(transport.reader, transport.writer, shared.Logger.with('ModelServer'));
   const server = create(connection);
   connection.listen();
   return server;
}
