/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerProtocol, TransferSaveDocumentArgs, TransferUpdateDocumentArgs } from '../data';
import type { RpcProxy } from '../rpc';
import type { TransferDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';

/** Update a document through a session; the session supplies `clientId`. */
export type DataSessionUpdateArgs<TTransfer> = Omit<TransferUpdateDocumentArgs<TTransfer>, 'clientId'>;

/** Persist a document through a session; the session supplies `clientId`. */
export type DataSessionSaveArgs<TTransfer> = Omit<TransferSaveDocumentArgs<TTransfer>, 'clientId'>;

/**
 * What a {@link DataSession} needs from the connection that minted it.
 *
 * Narrower than the connection itself so the dependency points one way:
 * `DataConnection` constructs sessions, and nothing here imports it back.
 */
export interface DataSessionHost<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer>> {
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
 */
export class DataSession<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer> = DataServerProtocol<TTransfer>> {
   /** URIs this session holds open, so {@link dispose} can release exactly those. */
   protected readonly openUris = new Set<string>();
   protected disposed = false;

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
    * Open `uri` for editing and start watching it, in that order, returning
    * the opened snapshot.
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
    */
   async openDocument(uri: string): Promise<TransferDocument<TTransfer>> {
      const server = await this.connected();
      const document = await server.openModelDocument({ uri, clientId: this.clientId });
      await server.watchModelDocument({ uri, clientId: this.clientId });
      this.openUris.add(uri);
      return document;
   }

   /**
    * Close `uri`. The server unwatches implicitly, so this is the dual of
    * {@link openDocument} and needs no separate unwatch.
    */
   async closeDocument(uri: string): Promise<void> {
      const server = await this.connected();
      this.openUris.delete(uri);
      await server.closeModelDocument({ uri, clientId: this.clientId });
   }

   /** Write `args.model` back as this session. */
   async updateDocument(args: DataSessionUpdateArgs<TTransfer>): Promise<TransferDocument<TTransfer>> {
      const server = await this.connected();
      return server.updateModelDocument({ ...args, clientId: this.clientId });
   }

   /** Persist `args.model` to disk as this session. */
   async saveDocument(args: DataSessionSaveArgs<TTransfer>): Promise<TransferDocument<TTransfer>> {
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
      this.openUris.clear();
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new Error('DataSession is disposed');
      }
   }
}
