/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { makeDuplexStreamPair } from './duplex-stream';

/**
 * Bidirectional in-process vscode-jsonrpc bridge — two MessageConnections
 * crossed over a PassThrough pair, both already listening. The framework's
 * standard in-process test transport.
 *
 * Typical use: wire a `DataServer` to `pair.left` and exercise it from a
 * client proxy on `pair.right` (or vice versa). Call `dispose` at test
 * teardown to release the underlying streams.
 */
export interface DuplexConnectionPair {
   readonly left: MessageConnection;
   readonly right: MessageConnection;
   dispose(): void;
}

export function makeDuplexConnectionPair(): DuplexConnectionPair {
   // `left` is the client side, `right` the server side: `clientToServer` is
   // what `left` writes and `right` reads; `serverToClient` is what `right`
   // writes and `left` reads.
   const pair = makeDuplexStreamPair();
   const { clientToServer, serverToClient } = pair;

   const left = createMessageConnection(new StreamMessageReader(serverToClient), new StreamMessageWriter(clientToServer));
   const right = createMessageConnection(new StreamMessageReader(clientToServer), new StreamMessageWriter(serverToClient));

   left.listen();
   right.listen();

   return {
      left,
      right,
      dispose(): void {
         left.dispose();
         right.dispose();
         pair.dispose();
      }
   };
}
