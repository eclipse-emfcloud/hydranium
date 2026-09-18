/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerProtocol, DiagnosticOf } from '../data';
import type { RpcProxy } from '../rpc';
import type { TransferDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';

/**
 * What one of `TServer`'s document methods takes, minus the `clientId` a
 * {@link DataSession} stamps itself.
 *
 * Read off the SERVER's signature, not off the framework's own arg type: an
 * adopter server widens these, and a wrapper declared against the narrow
 * shape rejects the extra field on a fresh object literal, so that call
 * cannot go through a session at all.
 */
export type DataSessionArgs<TMethod extends (args: never) => unknown> = Omit<Parameters<TMethod>[0], 'clientId'>;

/** Open a document through a session; the session supplies `clientId`. */
export type DataSessionOpenArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['openModelDocument']>;

/** Close a document through a session; the session supplies `clientId`. */
export type DataSessionCloseArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['closeModelDocument']>;

/** Update a document through a session; the session supplies `clientId`. */
export type DataSessionUpdateArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['updateModelDocument']>;

/** Persist a document through a session; the session supplies `clientId`. */
export type DataSessionSaveArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['saveModelDocument']>;

/** The document a session hands back, carrying its server's diagnostic shape. */
export type DataSessionDocument<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = TransferDocument<TTransfer, DiagnosticOf<TServer>>;

/**
 * What a {@link DataSession} needs from the connection that minted it.
 *
 * Narrower than the connection itself so the dependency points one way:
 * `DataConnection` constructs sessions, and nothing here imports it back.
 */
export interface DataSessionHost<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>>> {
   connected(): Promise<RpcProxy<TServer>>;
   releaseSession(session: DataSession<TTransfer, TServer>): void;
}

/**
 * One participant on a data connection: a properties panel, a tree, a
 * form editor.
 *
 * The server keys every hold and watch per `(uri, clientId)`, so the identity
 * belongs to the participant rather than to the wire — several sessions share
 * one connection, and two participants forced to share one identity cannot
 * distinguish each other's writes from their own echoes.
 *
 * Every document operation stamps {@link clientId} itself. A caller that
 * passed its own could pass another participant's, and the server would
 * attribute the write and release the hold accordingly.
 *
 * Generic over the transfer root so this file names no grammar.
 *
 * `TServer` is bound to a server answering with ITS OWN diagnostic shape, read
 * back off the parameter being bound. Simplifying that to
 * `DataServerProtocol<TTransfer>` compiles and costs the wrappers their
 * return type: every call through `TServer` would resolve against that looser
 * bound, so an adopter's diagnostics would come back as the framework's and
 * the document would have to be cast on the way out.
 */
export class DataSession<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> {
   /** URIs this session holds open, so {@link dispose} can release exactly those. */
   protected readonly openUris = new Set<string>();
   protected disposed = false;
   /**
    * Disposed through {@link detach} rather than {@link dispose}, so nothing may
    * be sent. Folding it into {@link disposed} costs {@link openDocument} the
    * distinction, and its close would then go out on a detached session.
    */
   protected detached = false;

   constructor(
      readonly clientId: string,
      protected readonly host: DataSessionHost<TTransfer, TServer>
   ) {}

   /**
    * The connected, READY server proxy, for protocol methods this session does
    * not wrap — the ones carrying no `clientId`, so no identity can be got
    * wrong through them.
    */
   async connected(): Promise<RpcProxy<TServer>> {
      // `async` so a disposed session REJECTS rather than throwing
      // synchronously: the connection's own `connected` rejects, and a caller
      // reaching for `.catch` on one of them would not catch the other.
      this.assertLive();
      return this.host.connected();
   }

   /**
    * Open `args.uri` for editing and start watching it, in that order,
    * returning the opened snapshot.
    *
    * **The order is the whole reason this method exists.**
    * `watchModelDocument` baselines its dedup fingerprint from the *current*
    * document, but only if one exists. Watching first therefore leaves no
    * baseline, and the first phase event after the open arrives as a spurious
    * `'changed'` — which a widget that resets its in-memory root to the server
    * view misreads as a concurrent third-party write, losing whatever the user
    * had typed. Nothing about the wrong order fails loudly, so it is encoded
    * here rather than documented and re-derived.
    *
    * Note that the returned snapshot's empty `diagnostics` does not mean
    * valid: `open` settles at the integrity landmark, not at validation.
    * Validity arrives asynchronously on `onDocumentUpdated`, or synchronously
    * from `getModelDocument({ includeDiagnostics: true })`.
    *
    * A dispose landing between the two awaits is handled here rather than in
    * {@link dispose}, which cannot release a hold that does not exist yet: it
    * reads {@link openUris}, and this method fills it only once both calls have
    * returned. Left to `dispose`, the hold and its watch outlive the participant
    * and go only when the connection closes.
    */
   async openDocument(args: DataSessionOpenArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      const server = await this.connected();
      const document = await server.openModelDocument({ ...args, clientId: this.clientId });
      await server.watchModelDocument({ uri: args.uri, clientId: this.clientId });
      if (this.disposed) {
         // Registering the URI BEFORE the open, so `dispose` could close on
         // intent, is NOT the same fix and can invert into the leak it is meant
         // to prevent: the close would then be issued while the open is still in
         // flight, and a peer that does not serialise the two can complete the
         // close first, after which the open re-registers the hold. Closing
         // strictly after the open has resolved is the only ordering with no
         // losing interleaving.
         if (!this.detached) {
            void server.closeModelDocument({ uri: args.uri, clientId: this.clientId }).catch(() => undefined);
         }
         // Returned rather than thrown: the caller that reaches this window is
         // one that never awaited the open, so a rejection here surfaces as an
         // unhandled one against a participant already gone.
         return document;
      }
      this.openUris.add(args.uri);
      return document;
   }

   /**
    * Close `args.uri`. The server unwatches implicitly, so this is the dual of
    * {@link openDocument} and needs no separate unwatch.
    */
   async closeDocument(args: DataSessionCloseArgs<TTransfer, TServer>): Promise<void> {
      const server = await this.connected();
      await server.closeModelDocument({ ...args, clientId: this.clientId });
      // Untracked only once the close has actually landed. Dropping it first
      // gives a FAILED close the same effect as a successful one: the hold
      // survives on the server and `dispose` no longer knows to retry it.
      // A `dispose` racing this therefore closes the same URI twice, which the
      // server answers as a no-op for a client that no longer holds it.
      this.openUris.delete(args.uri);
   }

   /** Write `args.model` back as this session. */
   async updateDocument(args: DataSessionUpdateArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      const server = await this.connected();
      return server.updateModelDocument({ ...args, clientId: this.clientId });
   }

   /** Persist `args.model` to disk as this session. */
   async saveDocument(args: DataSessionSaveArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      const server = await this.connected();
      return server.saveModelDocument({ ...args, clientId: this.clientId });
   }

   /**
    * Whether `sourceClientId` identifies this session's own write.
    *
    * Every watcher needs this and the check is one comparison, so getting it
    * wrong is cheap to do and expensive to find: an unfiltered echo looks
    * exactly like a concurrent third-party edit.
    */
   isOwnEcho(sourceClientId: string): boolean {
      return sourceClientId === this.clientId;
   }

   /**
    * Release this session's holds and detach it from the connection.
    * Idempotent, and leaves the connection usable by its other sessions.
    *
    * The closes are fired without being awaited, because a `Disposable` cannot
    * be: a host disposing a widget has nowhere to put the promise. A close
    * that fails is no worse than the leak this exists to prevent, so the
    * rejection is swallowed rather than surfaced from a teardown.
    */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      const uris = [...this.openUris];
      this.openUris.clear();
      this.host.releaseSession(this);
      for (const uri of uris) {
         void this.host
            .connected()
            .then(server => server.closeModelDocument({ uri, clientId: this.clientId }))
            .catch(() => undefined);
      }
   }

   /**
    * Come off the connection because it is going away.
    *
    * Sends no close, unlike {@link dispose}: the server releases every hold on
    * a connection it sees close, and the close would travel over the very
    * connection being disposed.
    */
   detach(): void {
      this.disposed = true;
      this.detached = true;
      this.openUris.clear();
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new Error('DataSession is disposed');
      }
   }
}
