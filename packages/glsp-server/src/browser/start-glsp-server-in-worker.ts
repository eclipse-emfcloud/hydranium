/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Logger as GlspLogger,
   type ServerModule,
   type WorkerLaunchOptions,
   WorkerServerLauncher,
   createAppModule
} from '@eclipse-glsp/server/browser.js';
import { Container, ContainerModule, injectable } from 'inversify';
import { createMessagePortTransport, sendByMethodName, type Logger, type TransferredMessagePort } from '@hydranium/protocol';
import { createMessageConnection } from 'vscode-jsonrpc/browser';
import type { IntegratedServer } from '@hydranium/core';
import { createGlspConnectionLogger } from '../launcher/glsp-connection-logger.js';
import { createGlspFrameworkOverrides } from '../launcher/glsp-framework-overrides.js';
import { createGlspServerOverrides } from '../launcher/glsp-server-overrides.js';

// Re-exported so the type of this head's `context` still resolves from here.
export type { TransferredMessagePort } from '@hydranium/protocol';

/**
 * The default worker launcher of {@link startGlspServerInWorker}: GLSP's
 * own, with its connection built over `createMessagePortTransport` rather than
 * over `BrowserMessageReader`/`BrowserMessageWriter`, which never report a
 * close. So the client disposing its connection closes this one, and upstream
 * disposes the server instance, and with it every client session, as it does
 * when a socket closes.
 *
 * Requires `context`: unlike upstream it never falls back to the worker global.
 *
 * The connection sends GLSP's typed messages by method name: it comes from this
 * package's copy of `vscode-jsonrpc` and the types from the copy
 * `@eclipse-glsp/protocol` resolves, and a type sent over another copy's
 * connection throws.
 */
@injectable()
export class HydraniumGlspWorkerServerLauncher extends WorkerServerLauncher {
   protected override createConnection(options: WorkerLaunchOptions): ReturnType<WorkerServerLauncher['createConnection']> {
      const transport = createMessagePortTransport(options.context as unknown as TransferredMessagePort);
      return sendByMethodName(createMessageConnection(transport.reader, transport.writer, createGlspConnectionLogger(this.logger)));
   }
}

/**
 * Binds GLSP's own `WorkerServerLauncher` token to
 * {@link HydraniumGlspWorkerServerLauncher}. {@link startGlspServerInWorker}
 * loads it before the adopter's `appModules`, so an adopter replaces the launcher
 * with `rebind`; a second `bind` makes the resolve ambiguous and the start throws.
 * A replacement extends {@link HydraniumGlspWorkerServerLauncher}: GLSP's own
 * launcher builds its connection from GLSP's copy, so framework errors lose
 * their code, and GLSP's typed messages throw where its packages nest
 * separate copies.
 */
export function createGlspWorkerLauncherModule(): ContainerModule {
   return new ContainerModule(bind => {
      bind(WorkerServerLauncher).to(HydraniumGlspWorkerServerLauncher);
   });
}

/**
 * Options for {@link startGlspServerInWorker}.
 *
 * The socket variant's options have no counterpart here and are deliberately
 * absent rather than ignored: there is no port to bind, none to discover, and
 * so nothing to publish over an LSP connection.
 *
 * @see {@link startGlspServerInWorker} for the lifecycle semantics.
 */
export interface BrowserGlspServerOptions {
   /**
    * The port the host transferred into the worker for this head.
    *
    * **Required: the worker global is no substitute.** A head on the global
    * receives every other head's traffic — a reader filters nothing, so this is
    * not a race under load but every message delivered to the wrong reader — and
    * GLSP's launcher posts its startup string through the global `postMessage`
    * regardless of the connection it was given, which no JSON-RPC reader parses.
    * Unlike upstream's, this head's launcher never falls back to the global.
    *
    * The page's end must connect through `createMessagePortTransport` as well:
    * the head reads its close signal from the port, and posts one on it.
    */
   readonly context: TransferredMessagePort;
   /**
    * Adopter-supplied logger factory. Called once per Inversify resolution
    * (with `caller` set to the requesting parent's class name) AND once
    * per `LoggerFactory` invocation.
    *
    * The GLSP log threshold is a property of the logger this returns, and there
    * is deliberately no launcher-level `logLevel` beside it — see the socket
    * variant's note on the same member.
    */
   readonly createLogger: (caller?: string) => GlspLogger;
   /**
    * The GLSP {@link ServerModule} with per-diagram modules pre-configured via
    * `new ServerModule().configureDiagramModule(...)`.
    */
   readonly serverModule: ServerModule;
   /**
    * Additional Inversify modules to load on the app container AFTER GLSP's
    * own app module, the framework overrides and
    * {@link createGlspWorkerLauncherModule}. Adopters wire language-services
    * bindings (e.g. their own shared-services symbol) here, and replace the
    * launcher with `rebind`.
    */
   readonly appModules?: ReadonlyArray<ContainerModule>;
   /**
    * Optional framework-lifecycle logger, for the launcher's own bringup and
    * failure lines. The GLSP container's logger handles application-level logs.
    */
   readonly logger?: Logger;
}

/**
 * Start a GLSP head on a transferred `MessagePort` inside a web worker, with no
 * Node runtime and no backend process.
 *
 * The worker counterpart of `startGlspServer`,
 * and deliberately a separate function rather than a mode of it. The two share
 * a shape — app module, framework overrides, adopter modules, resolve launcher,
 * configure the {@link ServerModule}, start — and almost nothing else: a
 * different launcher, a different upstream `createAppModule` whose options carry
 * no `fileLog`, and no `'listening'` event to resolve readiness on. Over half of
 * the socket options are meaningless here, so threading a flag would leave a
 * function whose contract depends on which branch the caller is in.
 *
 * Returns an {@link IntegratedServer} — the socket variant's `port` is the one
 * member a worker head has no answer for, so it is absent rather than
 * `undefined`.
 *
 * - `started` resolves once the launcher has built its connection and the
 *   server instance behind it, which is CHECKED rather than assumed — see
 *   below. There is no transport handshake to wait on: the port arrived live,
 *   and the launcher's own readiness signal is a string it posts on the worker
 *   global, which nothing here reads.
 * - `stopped` resolves when the connection closes, which the client disposing
 *   its connection causes, and rejects on a connection error. Nothing reports a
 *   page that dies, because the port cannot.
 */
export function startGlspServerInWorker(options: BrowserGlspServerOptions): IntegratedServer {
   const lifecycle = options.logger;

   // GLSP's own app module first, as on Node, so the framework tracks the
   // resolved GLSP version's app bindings instead of re-deriving them. This is
   // the BROWSER build's `createAppModule`, whose options are `LoggerConfigOptions`
   // — no `fileLog`, because there is no file to log to. `consoleLog` is forced
   // off so GLSP binds a throwaway NullLogger; the overrides below replace it
   // with the adopter's, which is also why no log level is passed here: with
   // `consoleLog` off, GLSP discards it, and the binding it would have
   // configured is unbound a line later.
   const glspAppModule = createAppModule({ consoleLog: false });

   const appContainer = new Container();
   appContainer.load(
      glspAppModule,
      createGlspFrameworkOverrides(options.createLogger),
      createGlspWorkerLauncherModule(),
      ...(options.appModules ?? [])
   );

   const launcher = appContainer.get<WorkerServerLauncher>(WorkerServerLauncher);
   // Additional module rather than an app-container binding, as on Node: the
   // launcher loads these into the per-connection SERVER container, the tier
   // where each connection gets a server of its own.
   launcher.configure(options.serverModule, createGlspServerOverrides());

   try {
      // Upstream declares `WorkerLaunchOptions.context` as `Worker`, and
      // `HydraniumGlspWorkerServerLauncher.createConnection` reads it as a
      // port — so the value that is CORRECT here is the one the declaration
      // names as wrong.
      //
      // **The cast is currently redundant, and is kept deliberately.** `Worker`
      // does not resolve under this package's `lib`, so `skipLibCheck` leaves
      // the option an error type and the assignment compiles without it —
      // measured, not assumed. Removing it would mean this file type-checks by
      // the same accident that let upstream's own `?? self` default pass, and
      // would break the day the name resolves. The cast states the intent
      // instead, and costs one line to do so.
      const launchOptions = { context: options.context } as unknown as WorkerLaunchOptions;
      // `start` resolves only when the connection closes, so it is the `stopped`
      // promise. The launcher builds the connection and the server instance
      // synchronously before returning it, which is what makes "we got here"
      // equal to "accepting traffic".
      const stoppedPromise = Promise.resolve(launcher.start(launchOptions));
      // Attached here and not left to the caller: a worker has no console
      // anyone is watching, so a connection error on a `stopped` nobody awaits
      // becomes an unhandled rejection that reaches no one. The handler also
      // marks the promise handled, which the caller's own `await` still sees.
      stoppedPromise.catch((error: unknown) => lifecycle?.error('[GlspServer] Worker connection error:', error));

      // The `started`-equals-synchronous-construction assumption above is
      // upstream's, so it is verified rather than trusted: `run` awaiting
      // anything before building the connection would leave `started` resolving
      // on a head that cannot yet answer, and a client's first request would
      // hang with nothing logged. The field is `protected`, reached by property
      // indexing as the socket launcher's `netServer` is.
      const connection = (launcher as unknown as { connection?: unknown }).connection;
      if (connection === undefined) {
         const error = new Error(
            'startGlspServerInWorker: the launcher built no connection synchronously — ' +
               'WorkerServerLauncher.run has become asynchronous and readiness now needs a real signal'
         );
         lifecycle?.error(`[GlspServer] ${error.message}`);
         return { started: Promise.reject(error), stopped: stoppedPromise };
      }

      lifecycle?.info('[GlspServer] Ready to accept client requests on the transferred port');
      return { started: Promise.resolve(), stopped: stoppedPromise };
   } catch (error) {
      lifecycle?.error('Error in GLSP server worker launcher:', error);
      return { started: Promise.reject(error), stopped: Promise.resolve() };
   }
}
