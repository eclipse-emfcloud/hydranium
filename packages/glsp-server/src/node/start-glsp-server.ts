/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Logger as GlspLogger,
   type ServerModule,
   type SocketLaunchOptions,
   SocketServerLauncher,
   createAppModule,
   defaultSocketLaunchOptions
} from '@eclipse-glsp/server/node.js';
import { Container, ContainerModule, injectable } from 'inversify';
import { Deferred, describeError, describeErrorWithStack, sendByMethodName, type Logger } from '@hydranium/protocol';
import type * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import {
   initializeWorkspaceWithoutLsp,
   type IntegratedServer,
   type ServerSharedServicesMinimal,
   type WorkspaceFolderInput
} from '@hydranium/core';
import { dropNotificationsToGoneClient } from '../launcher/drop-notifications-to-gone-client.js';
import { createGlspConnectionLogger } from '../launcher/glsp-connection-logger.js';
import { createGlspFrameworkOverrides } from '../launcher/glsp-framework-overrides.js';
import { createGlspServerOverrides } from '../launcher/glsp-server-overrides.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import type { LspConnectionLike } from '@hydranium/core/node';

/**
 * The default socket launcher of {@link startGlspServer}: GLSP's own,
 * with each connection built from this package's copy of `vscode-jsonrpc`, so a
 * framework error thrown in a handler keeps its code. The connection sends
 * GLSP's typed messages by method name, since GLSP builds them from its copy.
 */
@injectable()
export class HydraniumGlspSocketServerLauncher extends SocketServerLauncher {
   protected override createConnection(socket: net.Socket): ReturnType<SocketServerLauncher['createConnection']> {
      return dropNotificationsToGoneClient(
         sendByMethodName(
            createMessageConnection(
               new SocketMessageReader(socket),
               new SocketMessageWriter(socket),
               createGlspConnectionLogger(this.logger)
            )
         ),
         this.logger
      );
   }
}

/**
 * Binds GLSP's own `SocketServerLauncher` token to
 * {@link HydraniumGlspSocketServerLauncher}. {@link startGlspServer} loads it
 * before the adopter's `appModules`, so an adopter replaces the launcher with
 * `rebind`; a second `bind` makes the resolve ambiguous and the start throws.
 * A replacement extends {@link HydraniumGlspSocketServerLauncher}: GLSP's own
 * launcher builds its connection from GLSP's copy, so framework errors lose
 * their code, and GLSP's typed messages throw where its packages nest
 * separate copies.
 */
export function createGlspSocketLauncherModule(): ContainerModule {
   return new ContainerModule(bind => {
      bind(SocketServerLauncher).to(HydraniumGlspSocketServerLauncher);
   });
}

/**
 * Options for {@link startGlspServer}.
 *
 * @see {@link startGlspServer} for the lifecycle semantics.
 */
export interface GlspServerOptions {
   /**
    * Port to bind. Default `0` — OS-assigned ephemeral. Resolve the
    * actual port off {@link StartedGlspServer.port} once `started`
    * resolves (only then is the address info available).
    */
   readonly port?: number;
   /**
    * Host to bind. Default `'127.0.0.1'` (LOCAL ONLY) — the GLSP head is
    * traffic-only-from-the-companion-client by design; rebinding to a
    * routable address is an explicit opt-in that adopters must do
    * deliberately.
    */
   readonly host?: string;
   /**
    * Adopter-supplied logger factory. Called once per Inversify resolution
    * (with `caller` set to the requesting parent's class name) AND once
    * per `LoggerFactory` invocation.
    *
    * **The threshold belongs in here, not beside it.** GLSP's own log level is
    * a property of the logger this factory returns — e.g.
    * `GlspClientLogger` filters
    * each call against its own `logLevel` option. There is deliberately no
    * launcher-level `logLevel`: the framework replaces GLSP's `Logger` binding
    * outright, so anything passed to GLSP's app module would be discarded, and
    * an option that looks authoritative and is discarded is worse than none.
    */
   readonly createLogger: (caller?: string) => GlspLogger;
   /**
    * The GLSP {@link ServerModule} with per-diagram modules
    * pre-configured via `new ServerModule().configureDiagramModule(...)`.
    */
   readonly serverModule: ServerModule;
   /**
    * Additional Inversify modules to load on the app container AFTER GLSP's
    * own app module (via `createAppModule`, which binds `InjectionContainer`
    * plus the GLSP-version-specific app bindings), the framework overrides
    * that route GLSP's logger and logger factory through the adopter logger
    * and add the shared Tracer, and {@link createGlspSocketLauncherModule}.
    * Adopters wire language-services bindings (e.g. their own shared-services
    * symbol) here, and replace the launcher with `rebind`.
    */
   readonly appModules?: ReadonlyArray<ContainerModule>;
   /**
    * Workspace root(s) to initialize — a filesystem path or a `URI`. Required
    * when no LSP head is composed, refused beside one: see
    * `initializeWorkspaceWithoutLsp`. The shared services are the ones
    * `HydraniumGlspAppModule` binds in {@link appModules}.
    */
   readonly workspace?: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>;
   /**
    * Optional LSP connection used to register a port-discovery request
    * handler. When both `lspConnection` and `portCommand` are set, the
    * framework registers `lspConnection.onRequest(portCommand, () => port)`
    * after the GLSP socket is listening — the standard handshake adopters
    * use to bridge LSP clients to the GLSP head.
    */
   readonly lspConnection?: LspConnectionLike;
   /**
    * LSP request method name to register. Required when `lspConnection` is
    * set. Adopters define this constant in their own protocol package.
    */
   readonly portCommand?: string;
   /**
    * Optional framework-lifecycle logger. Receives `listening` / `error`
    * lifecycle messages from the launcher itself (the GLSP container's
    * own logger handles application-level GLSP logs).
    */
   readonly logger?: Logger;
   /**
    * Optional diagnostic hook called for every incoming `net.Socket` the
    * GLSP server's `net.Server` accepts. Fires as a side-effect of the
    * framework's own `'connection'` listener — GLSP's per-connection setup
    * runs independently from its own listener registered by
    * `SocketServerLauncher`. Adopters typically attach `'data'` / `'close'`
    * listeners inside the hook for byte-level observability when debugging
    * wire-level handshake issues.
    */
   readonly onClientConnection?: (socket: net.Socket) => void;
}

/**
 * Live GLSP server handle returned by {@link startGlspServer}.
 *
 * - {@link IntegratedServer.started} resolves once the workspace is up,
 *   where the launcher brings it up, AND the GLSP socket is listening AND
 *   (if configured) the port-discovery handler has been registered on the
 *   LSP connection. It rejects, and nothing listens, when the bring-up fails.
 * - {@link IntegratedServer.stopped} settles as GLSP's
 *   `SocketServerLauncher.start` promise does (i.e. once the underlying
 *   `net.Server` has closed), or resolves once a failed bring-up has
 *   rejected `started`.
 * - {@link port} is `undefined` until `started` resolves.
 */
export interface StartedGlspServer extends IntegratedServer {
   readonly port: number | undefined;
}

/**
 * Start a GLSP socket head. Builds the GLSP app container with framework-
 * default `Logger` / `LoggerFactory` bindings, layers adopter modules,
 * resolves the launcher bound to {@link SocketServerLauncher}, by default
 * {@link HydraniumGlspSocketServerLauncher}, configures the adopter
 * {@link ServerModule}, and starts listening.
 *
 * **GLSP launcher coupling.** GLSP's {@link SocketServerLauncher} owns the
 * `net.Server` and each connection's server instance;
 * the framework wrapper composes ABOVE that launcher rather than replacing
 * it. The framework's own `startSocketServer`
 * helper is NOT used here — it's designed for stdio/raw-JSON-RPC heads
 * (data-server's pattern), not GLSP's Inversify-driven per-connection
 * server-instance model. Bridging the two would lose GLSP's action-handler
 * registry plumbing.
 *
 * **Without an LSP head the launcher brings the workspace up, then
 * listens**, as `startSocketServer` does: a diagram loaded before the
 * bring-up starts keeps its cross-file edges missing for good.
 */
export function startGlspServer(options: GlspServerOptions): StartedGlspServer {
   const launchOptions: SocketLaunchOptions = {
      ...defaultSocketLaunchOptions,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0
   };
   const lifecycle = options.logger;

   // Start from GLSP's own app module rather than re-deriving its bindings by
   // hand. createAppModule binds InjectionContainer + Logger/LoggerFactory and
   // — crucially — whatever else the resolved GLSP version's app container needs,
   // so the framework tracks GLSP across versions instead of drifting. consoleLog /
   // fileLog are forced off so GLSP binds a throwaway NullLogger with no winston
   // instance; the override module below replaces Logger/LoggerFactory with the
   // adopter's logger, so GLSP server logs flow through options.createLogger.
   const glspAppModule = createAppModule({ ...launchOptions, consoleLog: false, fileLog: false });

   const appContainer = new Container();
   appContainer.load(
      glspAppModule,
      createGlspFrameworkOverrides(options.createLogger),
      createGlspSocketLauncherModule(),
      ...(options.appModules ?? [])
   );

   const launcher = appContainer.get<SocketServerLauncher>(SocketServerLauncher);
   // Passed as an additional module rather than folded into the app container:
   // the launcher loads these into the per-connection SERVER container, which is
   // the tier where each connection gets a server of its own.
   launcher.configure(options.serverModule, createGlspServerOverrides());

   const started = new Deferred<void>();
   const stopped = new Deferred<void>();
   const portHandle: { port: number | undefined } = { port: undefined };

   const listen = (): void => {
      // `start` creates the `net.Server` and listens, so the listeners below
      // attach to it synchronously after the call, before any event fires.
      Promise.resolve(launcher.start(launchOptions)).then(
         () => stopped.resolve(),
         (error: unknown) => stopped.reject(error)
      );

      // GLSP 2.7: the launcher has no `listening` or `onConnection`, so its
      // protected `netServer` is reached by property indexing. 2.8 still sets
      // the field before `start` returns.
      const netServer = (launcher as unknown as { netServer: net.Server }).netServer;

      netServer.on('listening', () => {
         const address = netServer.address();
         if (address && typeof address !== 'string') {
            portHandle.port = address.port;
            if (options.lspConnection && options.portCommand) {
               options.lspConnection.onRequest(options.portCommand, () => portHandle.port);
            }
            lifecycle?.info(`[GlspServer] Ready to accept new client requests on ${address.address} port: ${address.port}`);
            started.resolve();
         } else {
            const message = address === null ? 'address is null' : `bound to non-TCP "${String(address)}"`;
            lifecycle?.error(`[GlspServer] Could not resolve address info — ${message}. Shutting down.`);
            started.reject(new Error(`startGlspServer could not resolve address info — ${message}`));
            netServer.close();
         }
      });
      netServer.on('error', (err: Error) => {
         lifecycle?.error(`[GlspServer] Error: ${describeErrorWithStack(err)}`);
         started.reject(err);
      });
      if (options.onClientConnection) {
         netServer.on('connection', options.onClientConnection);
      }
   };

   // The workspace manager logs a failed initialization itself; a refused
   // `workspace` throws before `initializing` is set.
   let initializing = false;
   const begin = async (): Promise<void> => {
      const shared = appContainer.isBound(HydraniumTypes.SharedCoreServices)
         ? appContainer.get<ServerSharedServicesMinimal>(HydraniumTypes.SharedCoreServices)
         : undefined;
      if (shared === undefined) {
         throw new Error(
            '[hydranium] startGlspServer found no shared services in its app container. Add `new HydraniumGlspAppModule({ shared })` to `appModules`.'
         );
      }
      const initialization = initializeWorkspaceWithoutLsp(shared, options.workspace);
      initializing = true;
      await initialization;
      initializing = false;
      listen();
   };
   begin().catch((error: unknown) => {
      if (initializing) {
         lifecycle?.debug(`[GlspServer] Startup failed: the workspace did not initialize. ${describeError(error)}`);
      } else {
         lifecycle?.error(`[GlspServer] Startup failed: ${describeErrorWithStack(error)}`);
      }
      started.reject(error);
      stopped.resolve();
   });
   // Both are always observed internally, as `startStdioServer`'s `started`
   // is, so a caller that ignores them cannot crash the process. `stopped`
   // rejects when the socket fails, as on a port already in use.
   void started.promise.catch(() => undefined);
   void stopped.promise.catch(() => undefined);

   return {
      get port() {
         return portHandle.port;
      },
      started: started.promise,
      stopped: stopped.promise
   };
}
