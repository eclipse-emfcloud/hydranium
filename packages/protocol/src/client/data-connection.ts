/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, type Event } from 'vscode-jsonrpc';
import { FRAMEWORK_CLIENT_IDS } from '../client-ids';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol,
   type DiagnosticOf,
   type ProjectOf
} from '../data';
import type { TransferElement } from '../transfer-element';
import { DataEvents } from './data-events';
import type { DataPort } from './data-port';
import { DataSession, type DataSessionFactory } from './data-session';
import { RpcConnection, type RpcConnectionLifecycle } from './rpc-connection';

/** Options for {@link DataConnection}. */
export interface DataConnectionOptions<
   TTransfer extends TransferElement = TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> extends RpcConnectionLifecycle {
   /**
    * Wire namespace the server is addressed under. Defaults to the
    * framework's {@link DATA_SERVER_WIRE_PREFIX}, which is what an unmodified
    * `DataServer` binds. Override only alongside the server's own
    * `methodNamespace` option — a mismatch turns every request into
    * "Unhandled method" rather than failing at wire-up.
    */
   readonly methodNamespace?: string;
   /** Builds the sessions `createSession` hands out. Defaults to a plain {@link DataSession}. */
   readonly sessionFactory?: DataSessionFactory<TTransfer, TServer>;
}

/** {@link DataConnectionOptions} for a client that does not speak {@link DataClientProtocol}. */
export interface DataConnectionOptionsWithMethods<
   TClient extends object,
   TTransfer extends TransferElement = TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> extends DataConnectionOptions<TTransfer, TServer> {
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
export type DataConnectionArgs<
   TTransfer extends TransferElement,
   TClient extends object,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> =
   TClient extends DataClientProtocol<TTransfer>
      ? [options?: DataConnectionOptions<TTransfer, TServer> & Partial<DataConnectionOptionsWithMethods<TClient, TTransfer, TServer>>]
      : [options: DataConnectionOptionsWithMethods<TClient, TTransfer, TServer>];

/**
 * A {@link RpcConnection} to the data head, carrying as many participants as
 * the host has interested parties.
 *
 * Document operations live on the participants rather than here: they carry a
 * `clientId`, which identifies a participant rather than a wire, and the server
 * keys its opens and watches per `(uri, clientId)`. Two parties sharing one
 * identity cannot tell each other's writes from their own echoes.
 *
 * Generic over the transfer root so this file names no grammar. An adopter
 * binds the concrete root (or the union of them, for a multi-grammar head) at
 * its own edge.
 */
export class DataConnection<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>,
   TClient extends object = DataClientProtocol<TTransfer>
> extends RpcConnection<TServer, TClient> {
   protected readonly sessions = new Set<DataSession<TTransfer, TServer>>();
   protected readonly sessionFactory: DataSessionFactory<TTransfer, TServer>;
   protected readonly createSessionEmitter = new Emitter<DataSession<TTransfer, TServer>>();
   /**
    * Fires with each session {@link createSession} starts, before it returns,
    * so a listener sees every session a caller can. A session started before
    * the listener subscribed is in {@link liveSessions}.
    */
   readonly onDidCreateSession: Event<DataSession<TTransfer, TServer>> = this.createSessionEmitter.event;

   constructor(port: DataPort, client: TClient, ...rest: DataConnectionArgs<TTransfer, TClient, TServer>) {
      const [options = {}] = rest as [
         (DataConnectionOptions<TTransfer, TServer> & Partial<DataConnectionOptionsWithMethods<TClient, TTransfer, TServer>>)?
      ];
      super(port, client, {
         methodNamespace: options.methodNamespace ?? DATA_SERVER_WIRE_PREFIX,
         // The default is reachable only where `TClient` satisfies
         // `DataClientProtocol`, which the constructor's conditional enforces;
         // the compiler cannot carry that through to the generic parameter.
         clientMethods: options.clientMethods ?? (DATA_CLIENT_PROTOCOL_METHODS as unknown as readonly (keyof TClient & string)[]),
         lifecycle: options
      });
      this.sessionFactory =
         options.sessionFactory ?? ((clientId, host, label) => new DataSession<TTransfer, TServer>(clientId, host, label));
   }

   /**
    * The sessions of this connection that have not ended, in the order they
    * started. A session is listed until its `onDidDispose` fires, or until
    * {@link dispose} clears the list.
    */
   get liveSessions(): readonly DataSession<TTransfer, TServer>[] {
      return [...this.sessions];
   }

   /**
    * Start a participant on this connection, registered with the server under a
    * fresh id, `label` plus `#` plus a random UUID, or under `clientId` when
    * given. Pass a `label` naming the participant; without one it is
    * `session`. Synchronous: the registration is sent at once, and the
    * session's calls wait for it. The server refuses an id live anywhere in
    * its process, and every call of that session then rejects with a
    * `DuplicateClientIdError` code.
    *
    * Throws for an id in {@link FRAMEWORK_CLIENT_IDS} — those are authors the
    * SERVER emits rather than participants, so a session holding one would read
    * the framework's own broadcasts as its own echoes and drop them — and for
    * an id a live session on this connection already holds.
    */
   createSession(label = 'session', clientId?: string): DataSession<TTransfer, TServer> {
      this.assertLive();
      const id = clientId ?? `${label}#${globalThis.crypto.randomUUID()}`;
      if (FRAMEWORK_CLIENT_IDS.includes(id)) {
         throw new Error(`clientId '${id}' is reserved by the framework and cannot identify a participant`);
      }
      if ([...this.sessions].some(session => session.clientId === id)) {
         throw new Error(`clientId '${id}' already identifies a live participant on this connection`);
      }
      const session = this.sessionFactory(
         id,
         {
            connected: () => this.connected(),
            reportError: (error, reported) => this.reportError(error, reported)
         },
         label
      );
      this.sessions.add(session);
      // Subscribed before the session is handed out, so the id is free again
      // on this connection by the time any caller's listener runs.
      session.onDidDispose(() => this.sessions.delete(session));
      // A failure reaches the session's own calls, which wait for the same
      // registration; caught here only so it is not also reported unhandled.
      session.connected().catch(() => undefined);
      this.createSessionEmitter.fire(session);
      return session;
   }

   /**
    * After the transport dropped, reconnect on the next macrotask for the
    * sessions with documents open, so they re-watch and follow their documents
    * again without waiting for a call of their own; a session with nothing
    * open restores on its next call. Nothing is scheduled once this connection
    * is disposed, which drops its generation too.
    */
   protected override dropGeneration(): void {
      const dropped = this.generation !== undefined;
      super.dropGeneration();
      if (dropped && !this.disposed) {
         setTimeout(() => {
            if (!this.disposed) {
               this.sessions.forEach(session => session.reconnect());
            }
         }, 0);
      }
   }

   /**
    * Sessions are detached rather than disposed: the server ends every session
    * on a connection it sees close, so ending each one first sends requests
    * over a connection this call is about to dispose.
    */
   override dispose(): void {
      for (const session of [...this.sessions]) {
         session.detach();
      }
      // For a factory's session whose `detach` does not fire.
      this.sessions.clear();
      this.createSessionEmitter.dispose();
      super.dispose();
   }
}

/**
 * A {@link DataConnection} that brings its own {@link DataEvents}, so a host
 * with several interested parties does not have to supply one.
 *
 * **The client slot holds exactly one object, and that is why this exists.**
 * `createRpcProxy` binds a single `localTarget`, and underneath a method name
 * maps to one handler — a second registration replaces the first silently. So a
 * properties panel and a tree cannot both be the client; one fan-out sits in the
 * slot and both subscribe to it.
 *
 * Use {@link DataConnection} directly instead when the client is yours: an
 * adopter service that implements the protocol plus its own methods, a single
 * consumer that IS the client, or a request/response-only client that binds
 * nothing.
 */
export class DataConnectionWithEvents<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> extends DataConnection<TTransfer, TServer, DataEvents<TTransfer, DiagnosticOf<TServer>, ProjectOf<TServer>>> {
   /** Server pushes, fanned out to as many local listeners as the host has. */
   readonly events: DataEvents<TTransfer, DiagnosticOf<TServer>, ProjectOf<TServer>>;

   constructor(port: DataPort, options?: DataConnectionOptions<TTransfer, TServer>) {
      // Built as a local because `this` is unavailable before `super`, then
      // read back onto the field.
      const events = new DataEvents<TTransfer, DiagnosticOf<TServer>, ProjectOf<TServer>>();
      super(port, events, options);
      this.events = events;
   }

   /** Disposes the fan-out it created, which no caller else holds. */
   override dispose(): void {
      super.dispose();
      this.events.dispose();
   }
}
