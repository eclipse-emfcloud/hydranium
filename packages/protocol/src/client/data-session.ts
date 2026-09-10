/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { MessageConnection } from 'vscode-jsonrpc';
import { DATA_CLIENT_PROTOCOL_METHODS, DATA_SERVER_WIRE_PREFIX, type DataClientProtocol, type DataServerProtocol } from '../data';
import { defineMessage, describeError, resolve } from '../messages/primitives';
import { type RpcProxy, createRpcProxy } from '../rpc';
import type { TransferDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';
import type { DataPort } from './data-port';

/**
 * The transport never opened. A complete sentence rather than a fragment: a
 * fragment is nested inside a sentence the framework does not own, so no
 * translator controls the whole and the composition cannot be made to read
 * correctly in every language.
 */
export const DATA_SERVER_CONNECT_FAILED = defineMessage(
   'hydranium/protocol/data-server-connect-failed',
   'Could not connect to the data server: {detail}'
);

export const DATA_SERVER_NOT_READY = defineMessage(
   'hydranium/protocol/data-server-not-ready',
   'The data server did not become ready: {detail}'
);

/** Options for {@link DataSession}. */
export interface DataSessionOptions {
   /**
    * Wire namespace the server is addressed under. Defaults to the
    * framework's {@link DATA_SERVER_WIRE_PREFIX}, which is what an unmodified
    * `DataServer` binds. Override only alongside the server's own
    * `methodNamespace` option — a mismatch turns every request into
    * "Unhandled method" rather than failing at wire-up.
    */
   readonly methodNamespace?: string;
}

/** One connection generation: its connection, its proxy, and its readiness. */
interface Generation<TTransfer extends TransferElement> {
   readonly connection: Promise<MessageConnection>;
   readonly server: RpcProxy<DataServerProtocol<TTransfer>>;
   /** Set on first use; the shared readiness gate for this generation. */
   ready?: Promise<void>;
}

/**
 * The host-invariant half of talking to the data head: everything above
 * {@link DataPort} that would otherwise be re-derived by every host
 * adapter.
 *
 * Three jobs, and deliberately no fourth:
 *
 * 1. **Build the typed proxy** over the port's connection, with the framework's
 *    wire prefix and its drift-proof client-method allowlist.
 * 2. **Own the readiness gate** — `waitForReady` once per connection, shared
 *    across concurrent callers. A socket client can connect before the
 *    workspace walk finishes, and an early request is then answered correctly
 *    from an empty registry, which reads as a broken project tier rather than
 *    as a race.
 * 3. **Own the reconnect policy**, by dropping its connection generation when
 *    the port disposes and building a fresh one on the next request.
 *
 * It does **not** wrap the protocol methods; callers reach them through
 * {@link connected}. The one exception is {@link openDocument}, which exists
 * because the open/watch *order* is silently wrong the other way round — see
 * its own doc.
 *
 * Generic over the transfer root so this file names no grammar. An adopter
 * binds the concrete root (or the union of them, for a multi-grammar head) at
 * its own edge.
 */
export class DataSession<TTransfer extends TransferElement> {
   protected readonly methodNamespace: string;
   /** The current generation, or `undefined` before the first request / after a teardown. */
   protected generation?: Generation<TTransfer>;
   protected disposed = false;
   protected readonly portDisposeListener: { dispose(): void };

   constructor(
      protected readonly port: DataPort,
      protected readonly client: DataClientProtocol<TTransfer>,
      options: DataSessionOptions = {}
   ) {
      this.methodNamespace = options.methodNamespace ?? DATA_SERVER_WIRE_PREFIX;
      this.portDisposeListener = this.port.onDispose(() => this.dropGeneration());
   }

   /** The identity every request is made under — the port's, not a second one. */
   get clientId(): string {
      return this.port.clientId;
   }

   /**
    * The connected, READY server proxy.
    *
    * Returns the proxy rather than `void` on purpose. A reconnect replaces the
    * proxy, so a caller that cached one from an earlier call would go on
    * addressing a dead connection with no error — handing it back per call
    * makes the stale reference unrepresentable.
    *
    * Concurrent callers share one readiness promise, so `waitForReady` is
    * awaited once per generation and not once per caller.
    */
   async connected(): Promise<RpcProxy<DataServerProtocol<TTransfer>>> {
      if (this.disposed) {
         throw new Error('DataSession is disposed');
      }
      const generation = this.currentGeneration();
      if (!generation.ready) {
         generation.ready = this.awaitReady(generation);
      }
      await generation.ready;
      return generation.server;
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
      return document;
   }

   /**
    * Close `uri`. The server unwatches implicitly, so this is the dual of
    * {@link openDocument} and needs no separate unwatch.
    */
   async closeDocument(uri: string): Promise<void> {
      const server = await this.connected();
      await server.closeModelDocument({ uri, clientId: this.clientId });
   }

   /**
    * Whether `event.sourceClientId` identifies this session's own write.
    *
    * Every watcher needs this and the check is one comparison, so getting it
    * wrong is cheap to do and expensive to find: an unfiltered echo looks
    * exactly like a concurrent third-party edit.
    */
   isOwnEcho(sourceClientId: string): boolean {
      return sourceClientId === this.clientId;
   }

   /** Tear down the current connection and stop tracking the port. Idempotent. */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.portDisposeListener.dispose();
      this.dropGeneration();
   }

   /** The live generation, building one if there is none. */
   protected currentGeneration(): Generation<TTransfer> {
      if (this.generation) {
         return this.generation;
      }
      const connection = this.port.connect();
      // Rejection is reported here rather than left to float: an unhandled
      // rejection on a connection promise is the failure mode that reads as
      // "the model is empty" instead of "the transport never opened".
      connection.catch((error: unknown) =>
         this.port.reportError(error, resolve(DATA_SERVER_CONNECT_FAILED, { detail: describeError(error) }))
      );
      const server = createRpcProxy<DataServerProtocol<TTransfer>, DataClientProtocol<TTransfer>>(connection, {
         methodNamespace: this.methodNamespace,
         localTarget: this.client,
         localMethods: DATA_CLIENT_PROTOCOL_METHODS
      });
      this.generation = { connection, server };
      return this.generation;
   }

   /** Await the connection and the server's startup gate for one generation. */
   protected async awaitReady(generation: Generation<TTransfer>): Promise<void> {
      try {
         await generation.connection;
         await generation.server.waitForReady();
      } catch (error: unknown) {
         // Drop the generation so the next request retries rather than
         // re-awaiting a settled rejection forever.
         if (this.generation === generation) {
            this.generation = undefined;
         }
         this.port.reportError(error, resolve(DATA_SERVER_NOT_READY, { detail: describeError(error) }));
         throw error;
      }
   }

   /**
    * Discard the current generation, disposing its connection if it opened.
    * The next {@link connected} builds a fresh one.
    */
   protected dropGeneration(): void {
      const generation = this.generation;
      this.generation = undefined;
      if (!generation) {
         return;
      }
      generation.connection.then(connection => connection.dispose()).catch(() => undefined);
   }
}
