/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DATA_CLIENT_PROTOCOL_METHODS, DATA_SERVER_WIRE_PREFIX, type DataClientProtocol, type DataServerProtocol } from '../data';
import type { TransferElement } from '../transfer-element';
import type { DataPort } from './data-port';
import { DataSession } from './data-session';
import { RpcConnection, type RpcConnectionLifecycle } from './rpc-connection';

/** Options for {@link DataConnection}. */
export interface DataConnectionOptions extends RpcConnectionLifecycle {
   /**
    * Wire namespace the server is addressed under. Defaults to the
    * framework's {@link DATA_SERVER_WIRE_PREFIX}, which is what an unmodified
    * `DataServer` binds. Override only alongside the server's own
    * `methodNamespace` option — a mismatch turns every request into
    * "Unhandled method" rather than failing at wire-up.
    */
   readonly methodNamespace?: string;
}

/** {@link DataConnectionOptions} for a client that does not speak {@link DataClientProtocol}. */
export interface DataConnectionOptionsWithMethods<TClient extends object> extends DataConnectionOptions {
   /**
    * Method names of the client to bind as inbound handlers. Declare it
    * `as const satisfies ReadonlyArray<keyof YourClient & string>` so the list
    * cannot drift from the interface.
    */
   readonly clientMethods: readonly (keyof TClient & string)[];
}

/**
 * Trailing constructor arguments, required only when the client cannot take
 * the framework's default method list.
 *
 * `bindRpcMethods` throws for a name the target does not implement, so a
 * request/response-only client binding the default list fails at wire-up. The
 * conditional turns that into a compile error.
 */
export type DataConnectionArgs<TTransfer extends TransferElement, TClient extends object> =
   TClient extends DataClientProtocol<TTransfer>
      ? [options?: DataConnectionOptions & Partial<DataConnectionOptionsWithMethods<TClient>>]
      : [options: DataConnectionOptionsWithMethods<TClient>];

/**
 * A {@link RpcConnection} to the data head, carrying as many participants as
 * the host has interested parties.
 *
 * Document operations live on the participants rather than here: they carry a
 * `clientId`, which identifies a participant rather than a wire, and the server
 * keys its holds and watches per `(uri, clientId)`. Two parties sharing one
 * identity cannot tell each other's writes from their own echoes.
 *
 * Generic over the transfer root so this file names no grammar. An adopter
 * binds the concrete root (or the union of them, for a multi-grammar head) at
 * its own edge.
 */
export class DataConnection<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer> = DataServerProtocol<TTransfer>,
   TClient extends object = DataClientProtocol<TTransfer>
> extends RpcConnection<TServer, TClient> {
   protected readonly sessions = new Set<DataSession<TTransfer, TServer>>();

   constructor(port: DataPort, client: TClient, ...rest: DataConnectionArgs<TTransfer, TClient>) {
      const [options = {}] = rest as [(DataConnectionOptions & Partial<DataConnectionOptionsWithMethods<TClient>>)?];
      super(port, client, {
         methodNamespace: options.methodNamespace ?? DATA_SERVER_WIRE_PREFIX,
         // The default is reachable only where `TClient` satisfies
         // `DataClientProtocol`, which the constructor's conditional enforces;
         // the compiler cannot carry that through to the generic parameter.
         clientMethods: options.clientMethods ?? (DATA_CLIENT_PROTOCOL_METHODS as unknown as readonly (keyof TClient & string)[]),
         lifecycle: options
      });
   }

   /**
    * Mint a participant on this connection under `clientId`.
    *
    * `clientId` must be distinct per participant and stable for its lifetime:
    * it keys the server's per-`(uri, clientId)` hold and watch, and it is the
    * echo key an inbound `onDocumentUpdated` is matched against. Avoid the
    * three values the framework uses as sentinels — `'language-client'`,
    * `'unknown'` and `'revert-on-close'`.
    */
   createSession(clientId: string): DataSession<TTransfer, TServer> {
      this.assertLive();
      const session = new DataSession<TTransfer, TServer>(clientId, {
         connected: () => this.connected(),
         releaseSession: released => this.sessions.delete(released)
      });
      this.sessions.add(session);
      return session;
   }

   /**
    * Sessions are detached rather than disposed: the server releases every hold
    * on a connection it sees close, so closing each document first sends
    * requests over a connection this call is about to dispose.
    */
   override dispose(): void {
      for (const session of [...this.sessions]) {
         session.detach();
      }
      this.sessions.clear();
      super.dispose();
   }
}
