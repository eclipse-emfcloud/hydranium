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
import { DuplicateClientIdError, ReservedClientIdError, SessionClosedError } from './client-session-errors.js';

/**
 * What a client session states about one of its opens, kept by the session
 * and readable only while that open lasts.
 *
 * Any object type: an adopter declares the fields its own open path reads and
 * passes that type as a session's `TOpenOptions`. Kept per open rather than
 * per document, so two sessions opening one document with different options
 * each keep their own.
 */
export type OpenOptions = object;

/**
 * A session is `'live'` from its registration, which is synchronous, so no
 * state comes before it. `'closing'` covers the span in which the session's
 * opens are being closed: the id is still taken, and the session can open
 * nothing more, so an open issued from a close listener cannot outlive the
 * session that made it. An id with no state has no session: it was never
 * registered, or has closed.
 */
export type ClientSessionState = 'live' | 'closing';

/** Delivered by {@link ClientSessionRegistry.onDidCloseSession}. */
export interface ClientSessionClosedEvent {
   readonly clientId: string;
   readonly cause: SessionEndCause;
}

/**
 * Why a close happened. `'lost'` is a close caused by the client's connection
 * going away rather than by the client, and only such a last close waits out
 * the store's release grace: a client that closed or ended on purpose has
 * discarded its unsaved edits, while one that lost its connection may be about
 * to register again and open the document once more.
 */
export type SessionEndCause = 'closed' | 'lost';

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
 * Opens are recorded for every client id, registered or not. The language
 * client opens under its reserved id without a session, over the LSP
 * connection, and its opens are tracked exactly as a session's are; only the
 * session table ignores it. Requiring registration before an open would refuse
 * the editor.
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
   protected readonly opensByClient = new Map<string, Set<CanonicalUri>>();
   /**
    * Per document, the newest version id each client declared for its own
    * buffer: the baseline of the store's per-client staleness guard. A
    * client's goes when it closes the document, every one when the store
    * releases it.
    */
   protected readonly clientVersions = new Map<CanonicalUri, Map<string, number>>();
   protected readonly reservedIds: ReadonlySet<string> = new Set(RESERVED_CLIENT_IDS);
   protected readonly sessionClosedEmitter = new Emitter<ClientSessionClosedEvent>();

   /** Fires once a session has been removed from the table, after all its opens closed. */
   get onDidCloseSession(): Event<ClientSessionClosedEvent> {
      return this.sessionClosedEmitter.event;
   }

   /**
    * Enter `clientId` in the session table.
    *
    * Throws {@link ReservedClientIdError} for a reserved id, and
    * {@link DuplicateClientIdError} when the id is live anywhere in the
    * process: registered (including by a session that is still closing), or
    * holding opens as a client that is not a session. The last matters because
    * the id is the author label and the echo key, and a session sharing one
    * with another client would take that client's writes for its own.
    */
   register(clientId: string): void {
      if (this.reservedIds.has(clientId)) {
         throw new ReservedClientIdError(clientId);
      }
      if (this.sessions.has(clientId) || this.opensByClient.has(clientId)) {
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

   /**
    * Remove `clientId` from the session table, with every client version it
    * declared, and announce it with `cause`. A no-op for an id that is not
    * registered. The versions go too: a client registered again under the same
    * id counts its versions afresh.
    */
   unregister(clientId: string, cause: SessionEndCause = 'closed'): void {
      if (!this.sessions.delete(clientId)) {
         return;
      }
      for (const [uri, versions] of this.clientVersions) {
         if (versions.delete(clientId) && versions.size === 0) {
            this.clientVersions.delete(uri);
         }
      }
      this.sessionClosedEmitter.fire(Object.freeze({ clientId, cause }));
   }

   /**
    * Record that `clientId` opened `uri`. Returns `false` when
    * it already had it open, in which case nothing changes.
    *
    * Throws {@link SessionClosedError} for a session that is closing.
    */
   addOpen(uri: CanonicalUri, clientId: string): boolean {
      this.assertCanOpen(clientId);
      let opens = this.opensByClient.get(clientId);
      if (opens?.has(uri)) {
         return false;
      }
      if (!opens) {
         opens = new Set();
         this.opensByClient.set(clientId, opens);
      }
      opens.add(uri);
      let clients = this.clientsByUri.get(uri);
      if (!clients) {
         clients = new Set();
         this.clientsByUri.set(uri, clients);
      }
      clients.add(clientId);
      return true;
   }

   /** Throws {@link SessionClosedError} when `clientId` is a session that is closing, and so can open nothing more. */
   assertCanOpen(clientId: string): void {
      if (this.sessions.get(clientId) === 'closing') {
         throw new SessionClosedError(clientId);
      }
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
      const versions = this.clientVersions.get(uri);
      versions?.delete(clientId);
      if (!versions?.size) {
         this.clientVersions.delete(uri);
      }
      return true;
   }

   /** Take `version` as the newest `clientId` declared for `uri`, whether or not it has `uri` open. */
   setClientVersion(uri: CanonicalUri, clientId: string, version: number): void {
      let versions = this.clientVersions.get(uri);
      if (!versions) {
         versions = new Map();
         this.clientVersions.set(uri, versions);
      }
      versions.set(clientId, version);
   }

   /** The newest version id `clientId` declared for `uri`. */
   clientVersionOf(uri: CanonicalUri, clientId: string): number | undefined {
      return this.clientVersions.get(uri)?.get(clientId);
   }

   /** Drop every client version of `uri`, for a document the store released. */
   forgetClientVersions(uri: CanonicalUri): void {
      this.clientVersions.delete(uri);
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
      return [...(this.opensByClient.get(clientId) ?? [])];
   }

   /** Every document open in at least one client, with the clients that have it open. */
   openDocuments(): Array<{ readonly uri: CanonicalUri; readonly clients: string[] }> {
      return [...this.clientsByUri].map(([uri, clients]) => ({ uri, clients: [...clients] }));
   }

   /**
    * Forget every session and open without announcing
    * anything, for a test double that resets between tests. Subscriptions
    * stay, so a listener registered before the clear hears the sessions that
    * end after it.
    */
   clear(): void {
      this.sessions.clear();
      this.clientsByUri.clear();
      this.opensByClient.clear();
      this.clientVersions.clear();
   }
}
