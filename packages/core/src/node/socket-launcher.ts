/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred } from '@hydranium/langium';
import * as net from 'node:net';
import type { Disposable, Logger } from '@hydranium/protocol';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { IntegratedServer } from '../launcher/integrated-server.js';

/**
 * Construction-time options for {@link startSocketServer}.
 */
export interface SocketServerOptions {
   /**
    * Port to bind. Default `0` — OS-assigned ephemeral. Resolve the
    * actual port off {@link StartedSocketServer.port} once `started`
    * resolves (only then is the address info available).
    */
   readonly port?: number;
   /**
    * Optional logger. If omitted, the launcher runs silently — the
    * adopter is expected to surface lifecycle events through their own
    * logging in {@link OnClientConnection} if needed.
    */
   readonly logger?: Logger;
   /** Tag included in lifecycle log lines. Default `"SocketServer"`. */
   readonly logTag?: string;
}

/**
 * Adopter callback fired per inbound client. Receives the already-
 * constructed {@link MessageConnection} (created from the socket via
 * vscode-jsonrpc's `SocketMessageReader`/`SocketMessageWriter`) BEFORE
 * `connection.listen()` is called — the launcher invokes `listen()`
 * after the callback returns so adopters that need to register handlers
 * before message dispatch starts can do so.
 *
 * Adopters construct their per-client servers here and return a
 * {@link Disposable}. The launcher invokes the disposable on socket
 * close AND on server shutdown — adopters need not register their own
 * teardown listeners.
 *
 * Returning a no-op `{ dispose() {} }` is valid for heads whose servers
 * self-clean via `connection.onClose` (the framework's `DataServer`
 * being the canonical example).
 */
export type OnClientConnection = (connection: MessageConnection) => Disposable;

/**
 * Live socket server handle returned by {@link startSocketServer}.
 *
 * - {@link IntegratedServer.started} resolves once `listen` resolves
 *   AND `port` is populated.
 * - {@link IntegratedServer.stopped} resolves when the underlying
 *   `net.Server` emits `close`.
 * - {@link port} is undefined until `started` resolves.
 * - {@link close} triggers shutdown: disposes all active client
 *   connections and closes the underlying `net.Server`.
 */
export interface StartedSocketServer extends IntegratedServer {
   readonly port: number | undefined;
   close(): void;
}

/**
 * Start a socket-based protocol head. Wraps `net.createServer` with the
 * boilerplate adopters used to write per-head: address resolution,
 * error/close lifecycle, per-client `MessageConnection` construction,
 * connection tracking, and shutdown cleanup.
 *
 * **Multi-client semantics are framework-owned.** The launcher tracks
 * every accepted connection, invokes the adopter's `onClientConnection`
 * callback to wire per-client services, and disposes both the returned
 * adopter disposable AND the underlying `MessageConnection` on socket
 * close / server shutdown. Adopters keep per-client instance creation
 * (their server objects) but don't re-implement the tracking machinery.
 *
 * The port is only known once {@link StartedSocketServer.started} has
 * resolved, so announcing it — via {@link publishPortOnLspConnection} —
 * belongs after that await, not beside the call.
 */
export function startSocketServer(options: SocketServerOptions, onClientConnection: OnClientConnection): StartedSocketServer {
   const port = options.port ?? 0;
   const logger = options.logger;
   const tag = options.logTag ?? 'SocketServer';
   const started = new Deferred<void>();
   const stopped = new Deferred<void>();
   const handle: { port: number | undefined } = { port: undefined };

   // Tracks per-connection cleanup: the adopter's returned Disposable for
   // its per-client server objects PLUS the underlying MessageConnection
   // (so shutdown drains both at once).
   const activeConnections: Array<{ connection: MessageConnection; adopterDisposable: Disposable }> = [];

   const netServer = net.createServer(socket => {
      const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      const adopterDisposable = onClientConnection(connection);
      const entry = { connection, adopterDisposable };
      activeConnections.push(entry);
      // Cleanup hook fires once per connection — covers both socket-side
      // close and server-shutdown forced close.
      let disposed = false;
      const dispose = (): void => {
         if (disposed) {
            return;
         }
         disposed = true;
         try {
            adopterDisposable.dispose();
         } catch (err) {
            logger?.warn(`[${tag}] Adopter disposable threw on cleanup: ${(err as Error)?.message ?? err}`);
         }
         connection.dispose();
         const idx = activeConnections.indexOf(entry);
         if (idx >= 0) {
            activeConnections.splice(idx, 1);
         }
      };
      socket.on('close', dispose);
      connection.onClose(() => dispose());
      connection.listen();
   });

   netServer.listen(port);
   netServer.on('listening', () => {
      const addressInfo = netServer.address();
      if (!addressInfo) {
         logger?.error(`[${tag}] Could not resolve address info. Shutting down.`);
         started.reject(new Error(`${tag} could not resolve address info`));
         netServer.close();
         return;
      }
      if (typeof addressInfo === 'string') {
         logger?.error(`[${tag}] Unexpectedly listening to pipe or domain socket "${addressInfo}". Shutting down.`);
         started.reject(new Error(`${tag} bound to pipe/domain socket "${addressInfo}", expected TCP`));
         netServer.close();
         return;
      }
      handle.port = addressInfo.port;
      logger?.info(`[${tag}] Ready to accept new client requests on port: ${addressInfo.port}`);
      started.resolve();
   });
   netServer.on('error', err => {
      logger?.error(`[${tag}] Error: ${err.message}`);
      started.reject(err);
   });
   netServer.on('close', () => {
      // Active client cleanup. Snapshot first since `dispose()` mutates
      // the array.
      for (const entry of activeConnections.slice()) {
         try {
            entry.adopterDisposable.dispose();
         } catch (err) {
            logger?.warn(`[${tag}] Adopter disposable threw on shutdown: ${(err as Error)?.message ?? err}`);
         }
         entry.connection.dispose();
      }
      activeConnections.length = 0;
      stopped.resolve();
   });

   return {
      get port() {
         return handle.port;
      },
      started: started.promise,
      stopped: stopped.promise,
      close(): void {
         netServer.close();
      }
   };
}

/**
 * The shape the launcher needs from an LSP connection to publish a
 * port. Matches `vscode-languageserver`'s `Connection.onRequest` —
 * captured as a structural type here so the launcher doesn't take a
 * heavy `vscode-languageserver` dep just for the type.
 */
export interface LspConnectionLike {
   onRequest<TParams, TResult>(method: string, handler: (...params: TParams[]) => TResult): Disposable;
}

/**
 * Register a `<command>` request handler on the language-server LSP
 * connection that returns the port. Adopter clients call this command
 * to discover the head's port after the LSP handshake.
 *
 * No-op (returns a `{ dispose() {} }` disposable) when `lspConnection`
 * is `undefined` — Langium leaves `shared.lsp.Connection` optional and
 * adopters running headless (no LSP wire) want the same launcher
 * helpers to work.
 *
 * Adopters typically pass `services.shared.lsp.Connection`; both
 * `services.shared.lsp.Connection?` and the structural `LspConnectionLike`
 * shape are accepted.
 */
export function publishPortOnLspConnection(lspConnection: LspConnectionLike | undefined, command: string, port: number): Disposable {
   if (!lspConnection) {
      return { dispose: () => undefined };
   }
   return lspConnection.onRequest(command, () => port);
}
