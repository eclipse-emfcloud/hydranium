/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

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
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>,
   TClient extends object = DataClientProtocol<TTransfer>
> extends RpcConnection<TServer, TClient> {
   protected readonly sessions = new Set<DataSession<TTransfer, TServer>>();
   /**
    * Holds a disposed session could not release, keyed `clientId` + `uri` so a
    * repeated handover does not queue the same close twice.
    *
    * Retried on this connection's own activity rather than on a timer: every
    * session operation asks for the proxy, so a shared connection with anything
    * else going on supplies the occasions, and one with nothing going on has
    * nobody whose documents the stale hold could affect.
    */
   protected readonly orphanedHolds = new Map<string, { readonly uri: string; readonly clientId: string }>();
   /** Guards {@link releaseOrphanedHolds} against re-entering through its own proxy lookup. */
   protected releasingOrphans = false;

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
    * echo key an inbound `onDocumentUpdated` is matched against.
    *
    * Throws for an id in {@link FRAMEWORK_CLIENT_IDS} — those are authors the
    * SERVER emits rather than participants, so a session holding one would read
    * the framework's own broadcasts as its own echoes and drop them. Nothing
    * about that fails on its own: the document simply stops following, which
    * looks like a dead connection.
    *
    * Throws, too, for an id a LIVE session on this connection already holds.
    * Per-document membership is a set of client ids, so two participants
    * sharing one collapse to a single hold and the first close releases it
    * under the survivor, which then stops receiving updates for a document it
    * is still showing. A constant bound once per participant KIND — one per
    * widget class rather than per instance — satisfies the type and violates
    * this.
    *
    * And throws for an id whose previous session left a hold this connection is
    * still trying to release. That release closes `(uri, clientId)`, so an id
    * reissued while it is outstanding can have the new participant's hold closed
    * out from under it. The id frees itself as soon as the release lands.
    *
    * The checks span this connection only, so a head several connections reach
    * can still be addressed twice under one id.
    */
   createSession(clientId: string): DataSession<TTransfer, TServer> {
      this.assertLive();
      if (FRAMEWORK_CLIENT_IDS.includes(clientId)) {
         throw new Error(`clientId '${clientId}' is reserved by the framework and cannot identify a participant`);
      }
      if ([...this.sessions].some(session => session.clientId === clientId)) {
         throw new Error(`clientId '${clientId}' already identifies a live participant on this connection`);
      }
      if ([...this.orphanedHolds.values()].some(hold => hold.clientId === clientId)) {
         // A retry is still outstanding for this id, and it closes
         // `(uri, clientId)` — which the server keys one hold per. Handing the
         // id over now lets that close land on the NEW participant's hold
         // instead, taking a document away from a session that opened it
         // successfully. Nothing about that fails on its own: the document
         // simply stops following, and the close that did it was issued for a
         // participant already gone.
         //
         // Attempted first, so an id whose release has become possible is free
         // by the next call rather than waiting for other traffic.
         void this.releaseOrphanedHolds();
         throw new Error(`clientId '${clientId}' has an unreleased hold on this connection and cannot identify a new participant yet`);
      }
      const session = new DataSession<TTransfer, TServer>(clientId, {
         connected: async () => {
            const server = await this.connected();
            // Unawaited: a session's own operation must not wait on, or fail
            // for, the release of a hold another participant abandoned.
            void this.releaseOrphanedHolds();
            return server;
         },
         releaseSession: released => this.sessions.delete(released),
         orphanHold: (uri, holder) => this.orphanHold(uri, holder)
      });
      this.sessions.add(session);
      return session;
   }

   /**
    * Take over a `(uri, clientId)` hold a disposed session could not release.
    *
    * One attempt is made straight away, since whatever refused the session's
    * close may already be over; a refusal leaves the entry for the next
    * operation on this connection to retry.
    */
   protected orphanHold(uri: string, clientId: string): void {
      this.orphanedHolds.set(`${clientId}\u0000${uri}`, { uri, clientId });
      void this.releaseOrphanedHolds();
   }

   /**
    * Try to close every hold handed over by a disposed session, keeping the ones
    * the server still refuses.
    *
    * Errors are swallowed per entry: this runs off another participant's
    * operation, which has no interest in an unrelated release and no caller to
    * surface it to. A hold that survives every attempt is released by the
    * server's connection-close cleanup.
    */
   protected async releaseOrphanedHolds(): Promise<void> {
      if (this.releasingOrphans || this.orphanedHolds.size === 0 || this.disposed) {
         return;
      }
      this.releasingOrphans = true;
      try {
         const server = await this.connected();
         for (const [key, hold] of [...this.orphanedHolds]) {
            try {
               await server.closeModelDocument({ uri: hold.uri, clientId: hold.clientId });
               this.orphanedHolds.delete(key);
            } catch {
               // Kept for the next occasion.
            }
         }
      } catch {
         // No proxy to release through; the entries wait for one.
      } finally {
         this.releasingOrphans = false;
      }
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
      // Dropped rather than closed, for the same reason the sessions detach: the
      // server releases every hold on a connection it sees close, and the close
      // would travel over the connection being disposed.
      this.orphanedHolds.clear();
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

   constructor(port: DataPort, options?: DataConnectionOptions) {
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
