/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { MessageConnection } from 'vscode-jsonrpc';
import { defineMessage, describeError, resolve } from '../messages/primitives';
import { type RpcProxy, createRpcProxy } from '../rpc';
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

/** The one method a connection needs of any server: its startup gate. */
export interface ReadyServer {
   waitForReady(): Promise<void>;
}

/** Lifecycle reporting, for a host that raises warm-up UI around the two waits. */
export interface RpcConnectionLifecycle {
   /** A generation is opening its transport, including on each reconnect. */
   readonly onConnecting?: () => void;
   /** The server's readiness gate has settled for a generation. */
   readonly onReady?: () => void;
   /**
    * A generation failed to connect or to become ready. The failure is still
    * reported through {@link DataPort.reportError} and still rejects the
    * awaiting caller; this is for a host that also drives its own UI.
    */
   readonly onFailed?: (error: unknown) => void;
}

/** Everything {@link RpcConnection} needs once a subclass has resolved its defaults. */
export interface ResolvedRpcConnectionOptions<TClient extends object> {
   readonly methodNamespace: string;
   readonly clientMethods: readonly (keyof TClient & string)[];
   readonly lifecycle: RpcConnectionLifecycle;
}

/** One connection generation: its connection, its proxy, and its readiness. */
interface Generation<TServer extends object> {
   readonly connection: Promise<MessageConnection>;
   readonly server: RpcProxy<TServer>;
   /** Set on first use; the shared readiness gate for this generation. */
   ready?: Promise<void>;
}

/**
 * One JSON-RPC connection to a head, with the three jobs every host adapter
 * would otherwise re-derive above {@link DataPort}:
 *
 * 1. **Build the typed proxy** over the port's connection, with the caller's
 *    wire prefix and client-method allowlist.
 * 2. **Own the readiness gate** — `waitForReady` once per connection, shared
 *    across concurrent callers. A client can connect before the workspace walk
 *    finishes, and an early request is then answered correctly from an empty
 *    registry, which reads as a broken project tier rather than as a race.
 * 3. **Own the reconnect policy**, by dropping its generation when the port
 *    disposes and building a fresh one on the next request.
 *
 * Bounded only by {@link ReadyServer}, so a head serving a slice of the data
 * protocol — diagnostics alone, or one with methods excluded — is still a
 * legal server here. `DataConnection` narrows the bound because its sessions
 * call the document methods; nothing at this layer does.
 */
export class RpcConnection<TServer extends ReadyServer, TClient extends object> {
   protected readonly methodNamespace: string;
   protected readonly clientMethods: readonly (keyof TClient & string)[];
   protected readonly lifecycle: RpcConnectionLifecycle;
   /** The current generation, or `undefined` before the first request / after a teardown. */
   protected generation?: Generation<TServer>;
   protected disposed = false;
   protected readonly portDisposeListener: { dispose(): void };

   constructor(
      protected readonly port: DataPort,
      protected readonly client: TClient,
      options: ResolvedRpcConnectionOptions<TClient>
   ) {
      this.methodNamespace = options.methodNamespace;
      this.clientMethods = options.clientMethods;
      this.lifecycle = options.lifecycle;
      this.portDisposeListener = this.port.onDispose(() => this.dropGeneration());
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
   async connected(): Promise<RpcProxy<TServer>> {
      this.assertLive();
      const generation = this.currentGeneration();
      if (!generation.ready) {
         generation.ready = this.awaitReady(generation);
      }
      await generation.ready;
      return generation.server;
   }

   /**
    * The current generation's proxy WITHOUT awaiting readiness — calls queue
    * against the connection promise.
    *
    * Read per access, never cached: a reconnect replaces the generation, and a
    * held reference would address the dead one. Prefer {@link connected}, which
    * also waits for the server's startup gate.
    */
   get server(): RpcProxy<TServer> {
      this.assertLive();
      return this.currentGeneration().server;
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
   protected currentGeneration(): Generation<TServer> {
      if (this.generation) {
         return this.generation;
      }
      this.lifecycle.onConnecting?.();
      const connection = this.port.connect();
      // Rejection is reported here rather than left to float: an unhandled
      // rejection on a connection promise is the failure mode that reads as
      // "the model is empty" instead of "the transport never opened".
      connection.catch((error: unknown) =>
         this.port.reportError(error, resolve(DATA_SERVER_CONNECT_FAILED, { detail: describeError(error) }))
      );
      const server = createRpcProxy<TServer, TClient>(connection, {
         methodNamespace: this.methodNamespace,
         localTarget: this.client,
         localMethods: this.clientMethods
      });
      this.generation = { connection, server };
      return this.generation;
   }

   /** Await the connection and the server's startup gate for one generation. */
   protected async awaitReady(generation: Generation<TServer>): Promise<void> {
      try {
         await generation.connection;
         await generation.server.waitForReady();
         this.lifecycle.onReady?.();
      } catch (error: unknown) {
         this.lifecycle.onFailed?.(error);
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

   protected assertLive(): void {
      if (this.disposed) {
         throw new Error(`${this.constructor.name} is disposed`);
      }
   }
}
