/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Disposable, Emitter, type Event } from 'vscode-jsonrpc';
import { FRAMEWORK_CLIENT_IDS } from '../client-ids';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol,
   type DiagnosticOf,
   type ProjectOf,
   type TransferDocumentDirtyChangedEvent,
   type TransferDocumentUpdatedEvent
} from '../data';
import { DuplicateClientIdError, ReservedClientIdError } from '../errors';
import type { Logger } from '../logger';
import { defineMessage, describeError, resolve } from '../messages/primitives';
import { NoopLogger } from '../noop-logger';
import { randomUuid } from '../random-uuid';
import type { TransferElement } from '../transfer-element';
import { DataEvents } from './data-events';
import type { DataPort } from './data-port';
import { DataSession, type DataSessionFactory } from './data-session';
import { RpcConnection, type RpcConnectionGeneration, type RpcConnectionLifecycle } from './rpc-connection';

/**
 * A watch {@link DataConnection.watchDocument} keeps could not be sent again to
 * a connection that became ready after a drop; the next one sends it again.
 */
export const DATA_CONNECTION_WATCH_RESTORE_FAILED = defineMessage(
   'hydranium/protocol/data-connection-watch-restore-failed',
   'Could not watch {uri} again after reconnecting to the data server: {detail}'
);

/**
 * A session's restore threw when its connection came back; the connection
 * went on restoring the others.
 */
export const DATA_CONNECTION_SESSION_RESTORE_FAILED = defineMessage(
   'hydranium/protocol/data-connection-session-restore-failed',
   'Could not restore a session after reconnecting to the data server: {detail}'
);

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
 * {@link DataConnection.watchDocument} is the exception: it acts as no
 * participant, under an id no session holds, and opens or writes nothing.
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
   /**
    * Per URI, the `dirty` the client was last told, whether a session of this
    * connection has it open or a watch follows it. A session's open or close
    * of the URI forgets it; disposing a watch does not, since a watch knows
    * only the caller's spelling of the URI, not the server's key. A
    * session's restore and a watch sent again after a reconnect tell the
    * client their answer where it differs, a forgotten URI included; see
    * {@link restoreDirty}.
    */
   protected readonly dirtyStates = new Map<string, boolean>();
   /** Backs each session's {@link DataSessionHost.onDidChangeDirty}. */
   protected readonly dirtyChangedEmitter = new Emitter<TransferDocumentDirtyChangedEvent>();
   /** Backs each session's {@link DataSessionHost.onDidUpdateDocument}. */
   protected readonly documentUpdatedEmitter = new Emitter<TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>>();
   /**
    * Per id {@link watchDocument} watches under, the URI it watches, which
    * {@link generationReady} sends again to every later generation until the
    * watch's handle is disposed.
    */
   protected readonly watches = new Map<string, string>();
   /**
    * Per id, the URI of a watch whose handle was disposed with no ready
    * generation to unwatch on. {@link generationReady} sends the unwatch to the
    * next ready one: a generation that failed its readiness check after its
    * watches were sent leaves them on a connection the port may hand back.
    */
   protected readonly pendingUnwatches = new Map<string, string>();
   /** The port's logger, or one that logs nothing. */
   protected readonly logger: Logger;
   /** Backs {@link onDidReconnect}. */
   protected readonly reconnectEmitter = new Emitter<void>();
   /**
    * Fires on every reconnect: once a connection becomes ready after an
    * earlier one was, and its watches have been sent. The server sends no
    * event for a change made while the connection was down, so a watcher reads
    * its document again on this; a read it sends now reaches the server after
    * its watch.
    */
   readonly onDidReconnect: Event<void> = this.reconnectEmitter.event;
   /** Whether a generation was ready before, which makes the next one a reconnect. */
   protected readyBefore = false;

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
      this.logger = (port.logger ?? new NoopLogger()).for('DataConnection');
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
    * its process, and every call of that session then rejects with an error
    * `isDuplicateClientIdError` recognises; an id the server reserves beyond
    * {@link FRAMEWORK_CLIENT_IDS}, such as the integrity author, with one
    * `isReservedClientIdError` recognises. Only the code crosses the wire, so
    * test with those guards rather than `instanceof`.
    *
    * Throws a {@link ReservedClientIdError} for an id in
    * {@link FRAMEWORK_CLIENT_IDS} — those are authors the SERVER emits rather
    * than participants, so a session holding one would read the framework's
    * own broadcasts as its own echoes and drop them — and a
    * {@link DuplicateClientIdError} for an id a live session on this
    * connection already holds.
    */
   createSession(label = 'session', clientId?: string): DataSession<TTransfer, TServer> {
      this.assertLive();
      const id = clientId ?? `${label}#${randomUuid()}`;
      if (FRAMEWORK_CLIENT_IDS.includes(id)) {
         throw new ReservedClientIdError(id);
      }
      if ([...this.sessions].some(session => session.clientId === id)) {
         throw new DuplicateClientIdError(id);
      }
      const session = this.sessionFactory(
         id,
         {
            connected: () => this.connected(),
            reportError: (error, reported) => this.reportError(error, reported),
            restoreDirty: event => this.restoreDirty(event),
            forgetDirty: uri => this.dirtyStates.delete(uri),
            onDidChangeDirty: this.dirtyChangedEmitter.event,
            onDidUpdateDocument: this.documentUpdatedEmitter.event
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
    * Follow `uri` without opening it: its update events reach this
    * connection's client once this resolves. An open would hold the document
    * for as long as the caller follows it. The watch runs under an id of its
    * own, `label` plus `#` plus a random UUID, and needs no session: a session
    * closing the document would also end its own watch of it. Every later
    * connection that becomes ready gets the watch again. Disposing the handle
    * unwatches.
    */
   async watchDocument(uri: string, label = 'watch'): Promise<Disposable> {
      const clientId = `${label}#${randomUuid()}`;
      const server = await this.connected();
      // Kept only from here: kept during the wait, a generation that became
      // ready meanwhile would send the watch a second time.
      this.watches.set(clientId, uri);
      try {
         await server.watchModelDocument({ uri, clientId });
      } catch (error: unknown) {
         this.watches.delete(clientId);
         throw error;
      }
      this.logger.debug(`Watch ${uri} as ${clientId}`);
      return Disposable.create(() => {
         if (!this.watches.delete(clientId)) {
            return;
         }
         // Without a ready generation the unwatch waits for the next one,
         // rather than opening a connection only for it.
         const unwatchLater = (): void => {
            this.pendingUnwatches.set(clientId, uri);
         };
         const generation = this.generation;
         if (!generation) {
            unwatchLater();
            return;
         }
         (generation.ready ??= this.awaitReady(generation)).then(() => {
            if (this.generation === generation) {
               this.unwatch(generation, clientId, uri);
            } else {
               unwatchLater();
            }
         }, unwatchLater);
      });
   }

   /**
    * The client, with its `onDocumentDirtyChanged` passing through
    * {@link deliverDirty} first, so {@link dirtyStates} holds what the server
    * told it, and every session hears it through {@link dirtyChangedEmitter};
    * and with its `onDocumentUpdated` heard by every session through
    * {@link documentUpdatedEmitter} first. Every other bound method forwards
    * to the client unchanged, and one the client lacks stays absent, so the
    * binding still refuses it.
    */
   protected override localTarget(): TClient {
      const client = this.client as unknown as Record<string, unknown>;
      const hearsDirty = typeof client.onDocumentDirtyChanged === 'function';
      const hearsUpdates = typeof client.onDocumentUpdated === 'function';
      if (!hearsDirty && !hearsUpdates) {
         return this.client;
      }
      const target: Record<string, unknown> = {};
      for (const name of this.clientMethods) {
         const method: unknown = client[name];
         if (typeof method === 'function') {
            target[name] = (params: unknown): unknown => (method as (params: unknown) => unknown).call(client, params);
         }
      }
      if (hearsDirty) {
         target.onDocumentDirtyChanged = (event: TransferDocumentDirtyChangedEvent): void => {
            this.dirtyChangedEmitter.fire(event);
            this.deliverDirty(event);
         };
      }
      if (hearsUpdates) {
         const forward = target.onDocumentUpdated as (event: TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>) => void;
         target.onDocumentUpdated = (event: TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>): void => {
            this.documentUpdatedEmitter.fire(event);
            forward(event);
         };
      }
      return target as unknown as TClient;
   }

   /**
    * Hand a dirty state a restore read to the client, unless it is what
    * {@link dirtyStates} says the client was last told; a URI it holds
    * nothing for counts as different.
    */
   protected restoreDirty(event: TransferDocumentDirtyChangedEvent): void {
      if (this.dirtyStates.get(event.uri) !== (event.text?.dirty ?? false)) {
         this.deliverDirty(event);
      }
   }

   /** Record `event` in {@link dirtyStates} and hand it to the client. */
   protected deliverDirty(event: TransferDocumentDirtyChangedEvent): void {
      this.dirtyStates.set(event.uri, event.text?.dirty ?? false);
      const client = this.client as unknown as Partial<Pick<DataClientProtocol<TTransfer>, 'onDocumentDirtyChanged'>>;
      client.onDocumentDirtyChanged?.(event);
   }

   /**
    * After the transport dropped, reconnect on the next macrotask for the
    * sessions with documents open, so they re-watch and follow their documents
    * again without waiting for a call of their own, and connect for what
    * {@link watchDocument} watches, which {@link generationReady} places
    * again; a session with nothing open restores on its next call. Nothing is
    * scheduled once this connection is disposed, which drops its generation
    * too.
    */
   protected override dropGeneration(): void {
      const dropped = this.generation !== undefined;
      super.dropGeneration();
      if (dropped && !this.disposed) {
         setTimeout(() => {
            if (!this.disposed) {
               this.reconnectSessions();
               if (this.watches.size > 0) {
                  // One generation, not `connected`, which follows a drop to
                  // the next: that drop's own timer asks again whether
                  // anything is still kept. A failure is reported by the gate.
                  const generation = this.currentGeneration();
                  (generation.ready ??= this.awaitReady(generation)).catch(() => undefined);
               }
            }
         }, 0);
      }
   }

   /**
    * Call `reconnect()` on every session, reporting a throw instead of letting
    * one session's restore stop the others and the watches after them, and,
    * inside the readiness gate, fail the whole generation.
    */
   protected reconnectSessions(): void {
      for (const session of this.sessions) {
         try {
            session.reconnect();
         } catch (error: unknown) {
            // Reported, so it reaches the user on a port without a logger;
            // logged too, since only the log names the session.
            this.reportError(error, resolve(DATA_CONNECTION_SESSION_RESTORE_FAILED, { detail: describeError(error) }));
            this.logger.error(`Could not restore session ${session.clientId}: ${describeError(error)}`);
         }
      }
   }

   /**
    * Restore what the server lost with an earlier generation, whichever
    * request brought this one up: the documents of sessions that have some
    * open, and every watch {@link watchDocument} keeps.
    */
   protected override generationReady(generation: RpcConnectionGeneration<TServer>): void {
      super.generationReady(generation);
      this.reconnectSessions();
      this.watches.forEach((uri, clientId) => this.watchAgain(generation, clientId, uri));
      this.pendingUnwatches.forEach((uri, clientId) => this.unwatch(generation, clientId, uri));
      this.pendingUnwatches.clear();
      if (this.readyBefore) {
         this.reconnectEmitter.fire(undefined);
      }
      this.readyBefore = true;
   }

   /** Take back the watch of `uri` under `clientId` on `generation`; the server ignores one it does not hold. */
   protected unwatch(generation: RpcConnectionGeneration<TServer>, clientId: string, uri: string): void {
      this.logger.debug(`Unwatch ${uri} as ${clientId}`);
      generation.server.unwatchModelDocument({ uri, clientId }).catch(() => undefined);
   }

   /**
    * Send the watch of `uri` under `clientId` to `generation`, which has just
    * passed its readiness gate. Sent at once rather than after a wait, so no
    * drop can come between choosing the generation and sending. A failure is
    * reported, since no caller waits on it, only while the watch is kept and
    * `generation` is still current: otherwise the next generation sends it
    * again.
    *
    * Once the watch is in place, the document's dirty state is read and goes
    * through {@link restoreDirty}, as a session's restore does: a flip while
    * the connection was down reached no one.
    */
   protected watchAgain(generation: RpcConnectionGeneration<TServer>, clientId: string, uri: string): void {
      generation.server.watchModelDocument({ uri, clientId }).then(
         () => {
            if (!this.watches.has(clientId)) {
               return;
            }
            this.logger.debug(`Watch ${uri} again as ${clientId}`);
            generation.server.getModelDocument({ uri }).then(
               current => {
                  if (current.text && this.watches.has(clientId)) {
                     try {
                        this.restoreDirty({ uri: current.uri, text: current.text });
                     } catch {
                        // The client's listener failed, not the watch, which stays kept.
                     }
                  }
               },
               () => undefined
            );
         },
         (error: unknown) => {
            if (!this.watches.has(clientId)) {
               return;
            }
            if (this.generation !== generation) {
               this.logger.debug(`Watch of ${uri} as ${clientId} cut short by a lost connection; the next one sends it again`);
               return;
            }
            this.reportError(error, resolve(DATA_CONNECTION_WATCH_RESTORE_FAILED, { uri, detail: describeError(error) }));
         }
      );
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
      this.watches.clear();
      this.pendingUnwatches.clear();
      this.createSessionEmitter.dispose();
      this.reconnectEmitter.dispose();
      this.dirtyChangedEmitter.dispose();
      this.documentUpdatedEmitter.dispose();
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
