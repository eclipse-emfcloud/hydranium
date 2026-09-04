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
import { Container, type ContainerModule } from 'inversify';
import type { Logger } from '@hydranium/protocol';
import type { IntegratedServer } from '@hydranium/core';
import { createGlspFrameworkOverrides } from '../launcher/glsp-framework-overrides.js';
import { createGlspServerOverrides } from '../launcher/glsp-server-overrides.js';

/**
 * A `MessagePort` the host transferred into the worker, described structurally.
 *
 * This package inherits `tsconfig.base.json`'s `lib: ["ES2022"]` and so compiles
 * without the DOM lib, which is what keeps `document` / `window` compile errors
 * here — so `MessagePort` has no name either and the contract has to be spelled
 * out.
 *
 * **The member set is chosen to admit a `MessagePort` and REJECT a `Worker` or
 * the worker global**, both of which the launcher's own reader would otherwise
 * accept. Only a port needs starting, so `start` is what tells the three apart,
 * and naming it here turns "never bind a head to the global" from a rule in a
 * document into a compile error at the call site.
 *
 * **That compile error happens at the ADOPTER, not here.** This project resolves
 * neither `MessagePort` nor `Worker` as a type, so nothing in this package can
 * demonstrate the rejection; a host compiling its worker against `lib.webworker`
 * (or a page against `lib.dom`) is where the names resolve and the guard bites.
 * Measured there: passing the worker global fails with `Property 'start' is
 * missing in type 'DedicatedWorkerGlobalScope'`.
 *
 * `addEventListener` is not a discriminator — `postMessage` plus `start` already
 * excludes the other two — and nothing in this module calls any of the three
 * (the reader assigns `onmessage`, which starts a port implicitly). It is listed
 * because it is part of what the reader uses, so the interface reads as the
 * contract rather than as a minimal trick.
 */
export interface TransferredMessagePort {
   postMessage(message: unknown): void;
   addEventListener(type: 'message', listener: (event: unknown) => void, options?: unknown): void;
   start(): void;
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
    * **Required, and that is the whole point.** GLSP's
    * `WorkerServerLauncher.createConnection` falls back to the worker global
    * when it is omitted, and a head on the global receives every other head's
    * traffic — `BrowserMessageReader` filters nothing, so this is not a race
    * under load but every message delivered to the wrong reader. The global is
    * unusable even for a single head, because the launcher posts its startup
    * string through the global `postMessage` regardless of the connection it
    * was given, and no JSON-RPC reader can parse that.
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
    * own app module and the framework overrides. Adopters wire language-services
    * bindings (e.g. their own shared-services symbol) here.
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
 * - `stopped` resolves when the connection closes, and rejects on a connection
 *   error.
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
   appContainer.load(glspAppModule, createGlspFrameworkOverrides(options.createLogger), ...(options.appModules ?? []));

   const launcher = appContainer.resolve<WorkerServerLauncher>(WorkerServerLauncher);
   // Additional module rather than an app-container binding, as on Node: the
   // launcher loads these into the per-connection SERVER container, the only
   // tier where the adopter's `ServerModule` binding of `GLSPServer` is
   // rebindable.
   launcher.configure(options.serverModule, createGlspServerOverrides());

   try {
      // Upstream declares `WorkerLaunchOptions.context` as `Worker`, narrower
      // than the `MessagePort | Worker | DedicatedWorkerGlobalScope` its own
      // `BrowserMessageReader` accepts — so the value that is CORRECT here is
      // the one the declaration names as wrong.
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
