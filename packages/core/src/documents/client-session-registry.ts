/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, FRAMEWORK_CLIENT_IDS } from '@hydranium/protocol';
import { Emitter, type Event } from 'vscode-languageserver';
import { INTEGRITY_CLIENT_ID } from '../langium/integrity/integrity-rule.js';
import { DuplicateClientIdError, SessionClosedError } from './client-session-errors.js';

/**
 * What a client session states about one of its opens, kept per
 * `(session, uri)` for as long as that open lasts.
 *
 * Any object type: an adopter declares the fields its own open path reads and
 * passes that type as a session's `TOpenOptions`. Stored per open rather than
 * per document, so two sessions opening one document with different options
 * each keep their own.
 */
export type OpenOptions = object;

/**
 * `'closing'` covers the span in which a session's opens are being closed. The
 * id is still taken then, and the session can open nothing more, so an open
 * issued from a close listener cannot outlive the session that made it.
 */
export type ClientSessionState = 'live' | 'closing';

/** Delivered by {@link ClientSessionRegistry.onDidCloseSession}. */
export interface ClientSessionClosedEvent {
   readonly clientId: string;
}

/**
 * The ids no client session may be started under: the wire's well-known ids and
 * the integrity author. Each names a framework participant rather than a
 * client, and a session holding one would have its writes read as that
 * participant's.
 */
export const RESERVED_CLIENT_IDS: readonly string[] = [...FRAMEWORK_CLIENT_IDS, INTEGRITY_CLIENT_ID];

/**
 * Which client has which document open, and which client ids are registered
 * sessions — the open facts every head shares, composed by
 * `HydraniumTextDocuments`.
 *
 * Opens are recorded for every client id, registered or not. An id that was
 * never registered is a client that predates sessions and writes through the
 * flat `clientId` calls; its opens are tracked exactly as a session's are, and
 * only the session table ignores it. Requiring registration before an open
 * would refuse every such client.
 *
 * One open per `(client, uri)`, with no reference count: a repeat open changes
 * nothing, and one close ends it.
 *
 * Pure bookkeeping. Closing a document is the store's job, because a close has
 * to reach the text store and its listeners; the store asks this class what to
 * close and records each close here.
 */
export class ClientSessionRegistry {
   protected readonly sessions = new Map<string, ClientSessionState>();
   protected readonly clientsByUri = new Map<CanonicalUri, Set<string>>();
   /** Each client's opens, with the options it opened them with. */
   protected readonly opensByClient = new Map<string, Map<CanonicalUri, OpenOptions | undefined>>();
   protected readonly reservedIds: ReadonlySet<string> = new Set(RESERVED_CLIENT_IDS);
   protected readonly sessionClosedEmitter = new Emitter<ClientSessionClosedEvent>();

   /** Fires once a session has been removed from the table, after all its opens closed. */
   get onDidCloseSession(): Event<ClientSessionClosedEvent> {
      return this.sessionClosedEmitter.event;
   }

   /**
    * Enter `clientId` in the session table.
    *
    * Throws {@link DuplicateClientIdError} when the id is live anywhere in the
    * process: reserved, registered (including by a session that is still
    * closing), or holding opens as a client that is not a session. The last
    * matters because the id is the author label and the echo key, and a
    * session sharing one with another client would take that client's writes
    * for its own.
    */
   register(clientId: string): void {
      if (this.reservedIds.has(clientId) || this.sessions.has(clientId) || this.opensByClient.has(clientId)) {
         throw new DuplicateClientIdError(clientId);
      }
      this.sessions.set(clientId, 'live');
   }

   /** Whether `clientId` is in the session table, live or closing. */
   isRegistered(clientId: string): boolean {
      return this.sessions.has(clientId);
   }

   /**
    * Mark `clientId` as closing and return every URI it has open, as a copy the
    * caller can close while this registry changes underneath it.
    */
   beginClose(clientId: string): CanonicalUri[] {
      if (this.sessions.has(clientId)) {
         this.sessions.set(clientId, 'closing');
      }
      return this.opensOf(clientId);
   }

   /** Remove `clientId` from the session table and announce it. A no-op for an id that is not registered. */
   unregister(clientId: string): void {
      if (!this.sessions.delete(clientId)) {
         return;
      }
      this.sessionClosedEmitter.fire(Object.freeze({ clientId }));
   }

   /**
    * Record that `clientId` opened `uri`, with no options. Returns `false` when
    * it already had it open, in which case nothing changes.
    *
    * Throws {@link SessionClosedError} for a session that is closing.
    */
   addOpen(uri: CanonicalUri, clientId: string): boolean {
      if (this.sessions.get(clientId) === 'closing') {
         throw new SessionClosedError(clientId);
      }
      let opens = this.opensByClient.get(clientId);
      if (opens?.has(uri)) {
         return false;
      }
      if (!opens) {
         opens = new Map();
         this.opensByClient.set(clientId, opens);
      }
      opens.set(uri, undefined);
      let clients = this.clientsByUri.get(uri);
      if (!clients) {
         clients = new Set();
         this.clientsByUri.set(uri, clients);
      }
      clients.add(clientId);
      return true;
   }

   /** Record that `clientId` closed `uri`. Returns `false` when it did not have it open. */
   removeOpen(uri: CanonicalUri, clientId: string): boolean {
      const opens = this.opensByClient.get(clientId);
      if (!opens?.delete(uri)) {
         return false;
      }
      if (opens.size === 0) {
         this.opensByClient.delete(clientId);
      }
      const clients = this.clientsByUri.get(uri);
      clients?.delete(clientId);
      if (!clients?.size) {
         this.clientsByUri.delete(uri);
      }
      return true;
   }

   /** Whether `clientId` has `uri` open. */
   isOpenIn(uri: CanonicalUri, clientId: string): boolean {
      return !!this.clientsByUri.get(uri)?.has(clientId);
   }

   /** Whether any client has `uri` open. */
   isOpen(uri: CanonicalUri): boolean {
      return this.clientsByUri.has(uri);
   }

   /** The clients that have `uri` open, in the order they opened it. */
   clientsOf(uri: CanonicalUri): string[] {
      return [...(this.clientsByUri.get(uri) ?? [])];
   }

   /** The URIs `clientId` has open, in the order it opened them. */
   opensOf(clientId: string): CanonicalUri[] {
      return [...(this.opensByClient.get(clientId)?.keys() ?? [])];
   }

   /** Every document open in at least one client, with the clients that have it open. */
   openDocuments(): Array<{ readonly uri: CanonicalUri; readonly clients: string[] }> {
      return [...this.clientsByUri].map(([uri, clients]) => ({ uri, clients: [...clients] }));
   }

   /** The options `clientId` opened `uri` with, or `undefined` when it gave none or does not have it open. */
   openOptions(uri: CanonicalUri, clientId: string): OpenOptions | undefined {
      return this.opensByClient.get(clientId)?.get(uri);
   }

   /** Replace the options of an existing open. Does nothing when `clientId` does not have `uri` open. */
   setOpenOptions(uri: CanonicalUri, clientId: string, options: OpenOptions | undefined): void {
      const opens = this.opensByClient.get(clientId);
      if (opens?.has(uri)) {
         opens.set(uri, options);
      }
   }

   /**
    * Forget every session and open without announcing anything. Subscriptions
    * stay, so a listener registered before the clear hears the sessions that
    * end after it.
    */
   clear(): void {
      this.sessions.clear();
      this.clientsByUri.clear();
      this.opensByClient.clear();
   }
}
