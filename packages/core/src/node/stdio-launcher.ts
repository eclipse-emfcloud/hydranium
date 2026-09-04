/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred } from '@hydranium/langium';
import type { Disposable, Logger } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { IntegratedServer } from '../launcher/integrated-server.js';
import type { ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { initializeWorkspaceProgrammatically, type WorkspaceFolderInput } from '../langium/workspace/initialize-workspace.js';

/** Construction-time options for {@link startStdioServer}. */
export interface StdioServerOptions {
   /**
    * Shared services tree whose workspace is brought up before the first
    * request is dispatched. Required, because the ordering guarantee this
    * launcher exists to provide is stated in terms of it.
    */
   readonly shared: ServerSharedServicesMinimal;
   /**
    * Workspace root(s) to initialize — a filesystem path or a `URI`. Omit when
    * the caller has already initialized the workspace itself, in which case the
    * launcher only wires the transport.
    */
   readonly workspace?: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>;
   /**
    * Optional logger for lifecycle lines. Omitted means silent — note that a
    * logger writing to **stdout** would corrupt this head's protocol stream, so
    * anything passed here must sink elsewhere. The framework's own `LspLogger`
    * writes to stderr when no LSP connection is bound, which is correct here.
    */
   readonly logger?: Logger;
   /** Tag included in lifecycle log lines. Default `"StdioServer"`. */
   readonly logTag?: string;
   /**
    * Input stream carrying inbound JSON-RPC. Default `process.stdin`. Overriding
    * it is what lets a test drive the launcher over an in-memory duplex pair
    * instead of spawning a process.
    */
   readonly input?: NodeJS.ReadableStream;
   /** Output stream for outbound JSON-RPC. Default `process.stdout`. */
   readonly output?: NodeJS.WritableStream;
}

/**
 * Live stdio server handle returned by {@link startStdioServer}.
 *
 * - {@link IntegratedServer.started} resolves once the workspace is initialized
 *   AND the connection is listening — i.e. once the head can actually answer.
 *   It rejects if workspace initialization throws, so a caller awaiting it sees
 *   a failed startup rather than a server that is listening but empty.
 * - {@link IntegratedServer.stopped} resolves when the connection closes.
 */
export interface StartedStdioServer extends IntegratedServer {
   /** The underlying connection, for callers wanting fine-grained control. */
   readonly connection: MessageConnection;
   /** Dispose the adopter's per-connection state and close the connection. */
   close(): void;
}

/**
 * Start a **stdio**-based protocol head — the transport `hydranium-cli` speaks,
 * since `query` / `save` / `projects` / `watch` all spawn a server command and
 * drive JSON-RPC over its stdin/stdout. The socket counterpart is
 * `startSocketServer`; the two differ more
 * than the transport swap suggests, and the differences are the reason this is
 * a launcher rather than four lines in each adopter's entry.
 *
 * **One client, not N.** A socket head accepts arbitrarily many connections and
 * tracks them; a stdio head has exactly one peer — the process that spawned it
 * — for its whole lifetime. There is no accept loop and no connection registry.
 *
 * **Workspace initialization is the launcher's job, and its ordering is the
 * guarantee.** A stdio data head typically has no LSP connection, so it never
 * receives `initialize` / `initialized` and nothing else will bring the
 * workspace up. Worse, the ordering is easy to get subtly wrong: initialization
 * must complete **before** `connection.listen()`, because nothing reads the
 * input stream until the reader is attached, so a request that arrives during
 * startup waits in the pipe buffer. Listening first and initializing
 * concurrently instead leaves the outcome to whichever internal lock happened
 * to be held when the request landed — a race, not a guarantee, and one that
 * shows up as an empty project registry under load rather than as an error.
 *
 * The `onConnection` callback runs BEFORE initialization so handlers are
 * registered first, matching `startSocketServer`'s pre-`listen()` contract.
 */
export function startStdioServer(
   options: StdioServerOptions,
   onConnection: (connection: MessageConnection) => Disposable
): StartedStdioServer {
   const logger = options.logger;
   const tag = options.logTag ?? 'StdioServer';
   const started = new Deferred<void>();
   const stopped = new Deferred<void>();

   const connection = createMessageConnection(
      new StreamMessageReader(options.input ?? process.stdin),
      new StreamMessageWriter(options.output ?? process.stdout)
   );
   const adopterDisposable = onConnection(connection);

   let disposed = false;
   const close = (): void => {
      if (disposed) {
         return;
      }
      disposed = true;
      try {
         adopterDisposable.dispose();
      } catch (err: unknown) {
         logger?.warn(`[${tag}] Adopter disposable threw on cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
      connection.dispose();
      stopped.resolve();
   };
   connection.onClose(() => close());

   const begin = async (): Promise<void> => {
      if (options.workspace !== undefined) {
         logger?.info(`[${tag}] Initializing workspace`);
         await initializeWorkspaceProgrammatically(options.shared, options.workspace);
      }
      // Only now attach the reader — see the ordering note in the doc above.
      connection.listen();
      logger?.info(`[${tag}] Listening on stdio`);
   };

   begin().then(
      () => started.resolve(),
      (err: unknown) => {
         // A failed startup must not leave a half-live head: report it on
         // `started` and tear the connection down rather than listening over an
         // uninitialized workspace.
         logger?.error(`[${tag}] Startup failed: ${err instanceof Error ? err.message : String(err)}`);
         started.reject(err);
         close();
      }
   );
   // `started` is always observed internally, so a caller that ignores it can
   // never crash the process with an unhandled rejection.
   void started.promise.catch(() => undefined);

   return { started: started.promise, stopped: stopped.promise, connection, close };
}
