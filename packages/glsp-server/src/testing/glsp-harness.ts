/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import {
   type Action,
   type ActionMessage,
   ClientSessionManager,
   EndProgressAction,
   GLSPClientProxy,
   GLSPServer,
   ModelState,
   RequestBoundsAction,
   RequestModelAction,
   SOURCE_URI_ARG,
   SetDirtyStateAction,
   SetModelAction,
   StartProgressAction,
   StatusAction,
   UpdateModelAction,
   UpdateProgressAction
} from '@eclipse-glsp/server';
import {
   DefaultGLSPServer,
   InjectionContainer,
   Logger as GlspLogger,
   LoggerFactory,
   NodeActionDispatchScope,
   type ServerModule,
   getRequestParentName
} from '@eclipse-glsp/server/node.js';
import { ActionDispatchScope } from '@eclipse-glsp/server';
import { Container, ContainerModule, type interfaces } from 'inversify';
import type { AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import type { Harness } from '@hydranium/protocol/testing';
import type { AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { createGlspServerOverrides } from '../launcher/glsp-server-overrides.js';
import { makeNoopGlspLogger } from './make-noop-glsp-logger.js';

/**
 * Options for {@link makeGlspHarness}.
 *
 * The harness drives a REAL {@link GLSPServer} in-process: it composes the
 * server container the way `startGlspServer` does (framework default app
 * module + adopter `appModules` + the adopter `serverModule`), but binds
 * {@link GLSPClientProxy} to a capturing stub instead of a socket-backed
 * proxy, so every action the server pushes to the client lands in the
 * harness's `actions` capture. There is no OS socket and no JSON
 * serialization, so nothing here covers the wire layer.
 *
 * `serverModule` + `diagramType` are required; everything else has a
 * test-friendly default. The adopter's shared services / id provider /
 * conflict resolver come from `appModules` (typically an
 * `HydraniumGlspAppModule` subclass) — exactly as in production, so
 * the harness binds none of them itself.
 */
export interface MakeGlspHarnessOptions {
   /** Adopter {@link ServerModule} with its diagram module(s) pre-configured via `configureDiagramModule`. */
   readonly serverModule: ServerModule;
   /** Diagram type id passed to `initializeClientSession`; must match the configured diagram module. */
   readonly diagramType: string;
   /**
    * Adopter Inversify modules loaded AFTER the framework default module
    * (which binds `InjectionContainer`, GLSP's `Logger`, `LoggerFactory` and
    * `ActionDispatchScope`). Carries the adopter's
    * `HydraniumTypes.SharedCoreServices` / `HydraniumTypes.ConflictResolver` /
    * language-services bindings. Per-language providers come from the diagram
    * module instead — see `AbstractHydraniumGlspDiagramModule`.
    */
   readonly appModules?: ReadonlyArray<ContainerModule>;
   /**
    * GLSP logger factory. Default: a silent logger (the harness keeps the
    * test output clean). Override to capture GLSP framework log lines.
    */
   readonly createLogger?: (caller?: string) => GlspLogger;
   /** `applicationId` for the `initialize` handshake. Default `'test-app'`. */
   readonly applicationId?: string;
   /** Client session id used for `initializeClientSession` + every dispatched `ActionMessage`. Default `'test-session'`. */
   readonly clientSessionId?: string;
   /**
    * Adopter-specific client action kinds to forward IN ADDITION to
    * {@link DEFAULT_CLIENT_ACTION_KINDS}. The server's
    * `ClientActionForwarder` only forwards declared kinds to the capturing
    * `GLSPClientProxy`, so list any custom server→client action a test needs
    * to observe. The standard set covers ordinary round-trips, so most tests
    * leave this unset.
    */
   readonly additionalClientActionKinds?: ReadonlyArray<string>;
}

/**
 * The standard client-bound action kinds a real GLSP client handles — the
 * minimal set needed for any model round-trip. The harness declares these on
 * the session by default so the capturing {@link GLSPClientProxy} receives
 * them and the action dispatcher never errors with "no handler registered"
 * for an ordinary server→client action. Adopter-specific kinds are added via
 * {@link MakeGlspHarnessOptions.additionalClientActionKinds}.
 */
const DEFAULT_CLIENT_ACTION_KINDS: ReadonlyArray<string> = [
   SetModelAction.KIND,
   UpdateModelAction.KIND,
   RequestBoundsAction.KIND,
   SetDirtyStateAction.KIND,
   StatusAction.KIND,
   StartProgressAction.KIND,
   UpdateProgressAction.KIND,
   EndProgressAction.KIND
];

/** Options for {@link GlspHarness.nextModelSubmission}. */
export interface NextModelSubmissionOptions {
   /** How long to wait. Defaults to 2000ms. */
   readonly timeoutMs?: number;
   /**
    * Reject on timeout (default `true`) or resolve `undefined` (`false`). Pair
    * `false` with a short `timeoutMs` — the wait runs to completion in the
    * passing case.
    */
   readonly rejectOnTimeout?: boolean;
}

/**
 * Bundle returned by {@link makeGlspHarness}. Satisfies the uniform
 * {@link Harness} contract — `state` is the **subject** (the resolved adopter
 * state under test), `server` + `dispatch`/`nextAction` are the **seam** tests
 * drive the action round-trip through, `actions` is the **capture** of every
 * outbound action in arrival order, and `dispose()` is the uniform teardown
 * hook. `state` / `sessionContainer` are only valid after {@link start} (the
 * `ModelState` lives in GLSP's per-session child container, created by
 * `initializeClientSession`).
 */
export interface GlspHarness<TState extends AbstractHydraniumGlspState<AstNode, unknown>> extends Harness {
   /** The real GLSP server under test. */
   readonly server: GLSPServer;
   /** The main (app + server) container. */
   readonly container: interfaces.Container;
   /** The per-session child container `initializeClientSession` created. Throws if read before {@link start}. */
   readonly sessionContainer: interfaces.Container;
   /** The adopter `ModelState` resolved from {@link sessionContainer}. Throws if read before {@link start}. */
   readonly state: TState;
   /** Every action the server pushed to the client, in arrival order. Never cleared by the harness. */
   readonly actions: ReadonlyArray<Action>;

   /** Drive `initialize` then `initializeClientSession`; resolve once the session container exists. */
   start(): Promise<void>;
   /** Drive `server.shutdown()` (disposes client sessions). */
   shutdown(): Promise<void>;
   /** Send an action to the server as `{ clientId, action }`. Fire-and-forget (GLSP `process` is `void`). */
   dispatch(action: Action): void;
   /**
    * Resolve with the next captured action whose `kind` matches — an
    * already-captured-but-unconsumed match resolves immediately, otherwise
    * waits for the next arrival. Rejects after `timeoutMs` (default 2000) so
    * a missing action fails fast instead of hanging.
    */
   nextAction<T extends Action = Action>(kind: string, timeoutMs?: number): Promise<T>;
   /**
    * FAITHFUL fidelity: open `sourceUri` the way a client does — dispatch
    * `RequestModelAction` with `SOURCE_URI_ARG` — and resolve with the model
    * the server publishes in response.
    *
    * Resolves on **whichever** submission action the diagram produces, because
    * that depends on its `DiagramConfiguration` rather than on the test:
    * `SetModelAction` for a server-laid-out diagram, `RequestBoundsAction` for
    * a client-laid-out one. Awaiting the wrong one is a 2s timeout that names
    * the wrong subsystem, and a test should not have to know which applies.
    *
    * Rejects if nothing is published within `timeoutMs`. Valid only after
    * {@link start}.
    */
   openDocument(sourceUri: string, timeoutMs?: number): Promise<Action>;
   /**
    * Resolve with the next action that publishes a model — the settling point
    * after an operation, since a successful operation re-submits.
    *
    * Kind-agnostic for the same reason as {@link openDocument}. Set
    * `rejectOnTimeout: false` to ask whether a submission happened *at all*.
    */
   nextModelSubmission(options?: NextModelSubmissionOptions): Promise<Action | undefined>;
   /**
    * LIGHT fidelity: seed the state's source root directly via
    * `setSourceRoot`, bypassing source-model storage. Valid only after
    * {@link start}.
    */
   seedSourceRoot(uri: string, root: Parameters<TState['setSourceRoot']>[1]): void;

   /** Idempotent teardown: `server.shutdown()` then `container.unbindAll()`. */
   dispose(): void;
}

interface PendingWaiter {
   /** Kinds this waiter accepts; the first arrival matching any of them wins. */
   readonly kinds: ReadonlyArray<string>;
   readonly resolve: (action: Action | undefined) => void;
   timer: ReturnType<typeof setTimeout>;
}

/**
 * The actions that mean "the server published a model".
 *
 * Which one arrives depends on the diagram's `DiagramConfiguration`, not on
 * what the test did: a server-laid-out diagram gets `SetModelAction`, a
 * client-laid-out one (`needsClientLayout`) gets `RequestBoundsAction`, and a
 * re-submit after an operation may be `UpdateModelAction`. Tests that only care
 * *that* the model was published should not have to encode that choice — see
 * {@link GlspHarness.nextModelSubmission}.
 *
 * Exported for the tests that must COUNT submissions rather than await the next
 * one (asserting that nothing further was published, say). Re-listing the kinds
 * in such a test is a false-green shape: a kind added here would leave the copy
 * silently under-counting.
 */
export const MODEL_SUBMISSION_KINDS: ReadonlyArray<string> = [SetModelAction.KIND, UpdateModelAction.KIND, RequestBoundsAction.KIND];

/**
 * Wire a real {@link GLSPServer} in-process and drive a GLSP action
 * round-trip against it — dispatch an action → operation/request handler →
 * GModel mutation → response action, captured via a stub
 * {@link GLSPClientProxy}.
 *
 * The harness composes ONE container, collapsing production's parent
 * app-container / per-connection child split, which exists only to share the
 * app container across socket connections.
 */
export function makeGlspHarness<TState extends AbstractHydraniumGlspState<AstNode, unknown>>(
   options: MakeGlspHarnessOptions
): GlspHarness<TState> {
   const applicationId = options.applicationId ?? 'test-app';
   const clientSessionId = options.clientSessionId ?? 'test-session';
   const clientActionKinds = [...DEFAULT_CLIENT_ACTION_KINDS, ...(options.additionalClientActionKinds ?? [])];
   const createLogger = options.createLogger ?? (() => makeNoopGlspLogger());

   const actions: Action[] = [];
   const consumed = new WeakSet<Action>();
   const waiters: PendingWaiter[] = [];

   const captureProxy: GLSPClientProxy = {
      process(message: ActionMessage): void {
         const { action } = message;
         actions.push(action);
         const index = waiters.findIndex(waiter => waiter.kinds.includes(action.kind));
         if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            consumed.add(action);
            clearTimeout(waiter.timer);
            waiter.resolve(action);
         }
      }
   };

   /**
    * Resolve with the first unconsumed action matching any of `kinds` — one
    * already captured resolves immediately, otherwise the next arrival wins.
    *
    * `rejectOnTimeout` is what lets a caller distinguish the two questions a
    * test asks. `true` (the default) is "this must happen", and a timeout is a
    * failure naming the kinds. `false` is "did this happen?", resolving
    * `undefined` — needed because a **rejected** operation produces no action
    * at all, so the only observable is the absence of one. Mirrors GLSP's own
    * `ActionDispatcher.requestUntil(action, timeoutMs, rejectOnTimeout)`.
    */
   function waitFor(kinds: ReadonlyArray<string>, timeoutMs: number, rejectOnTimeout: boolean): Promise<Action | undefined> {
      const existing = actions.find(action => kinds.includes(action.kind) && !consumed.has(action));
      if (existing) {
         consumed.add(existing);
         return Promise.resolve(existing);
      }
      return new Promise<Action | undefined>((resolve, reject) => {
         const waiter: PendingWaiter = {
            kinds,
            resolve,
            timer: setTimeout(() => {
               const index = waiters.indexOf(waiter);
               if (index >= 0) {
                  waiters.splice(index, 1);
               }
               if (rejectOnTimeout) {
                  // Name what DID arrive. A bare "no X within 2000ms" reads as a
                  // hang and points at the transport, when the usual cause is an
                  // operation handler that threw or declined: the server then
                  // emits nothing, or emits only a status/dirty-state action.
                  // Distinguishing "nothing happened" from "something else
                  // happened" is the difference between a five-minute hunt and a
                  // one-line diagnosis.
                  const seen = actions.map(captured => captured.kind);
                  const context = seen.length === 0 ? 'no actions were captured at all' : `captured since start: ${seen.join(', ')}`;
                  reject(
                     new Error(
                        `makeGlspHarness: no ${kinds.map(kind => `'${kind}'`).join(' / ')} action within ${timeoutMs}ms — ${context}`
                     )
                  );
               } else {
                  resolve(undefined);
               }
            }, timeoutMs)
         };
         waiters.push(waiter);
      });
   }

   const defaultAppModule = new ContainerModule(bind => {
      bind(InjectionContainer).toDynamicValue(ctx => ctx.container);
      bind(GlspLogger).toDynamicValue(ctx => createLogger(getRequestParentName(ctx)));
      bind(LoggerFactory).toFactory(() => (caller: string) => createLogger(caller));
      // `DefaultActionDispatcher` injects this to tell a reentrant dispatch (from
      // inside a running handler, which must run inline) from an external one
      // (which queues). Mirrors GLSP's own `createAppModule`; without it every
      // dispatch throws on `dispatchScope.isReentrant`.
      bind(ActionDispatchScope).to(NodeActionDispatchScope).inSingletonScope();
      bind(HydraniumTypes.Tracer).toDynamicValue(ctx => {
         const tracer = ctx.container.get<ServerSharedServices>(HydraniumTypes.SharedCoreServices).Tracer;
         const caller = getRequestParentName(ctx);
         return caller ? tracer.for(caller) : tracer;
      });
   });
   const captureProxyModule = new ContainerModule(bind => {
      bind(GLSPClientProxy).toConstantValue(captureProxy);
   });

   const container = new Container();
   container.load(defaultAppModule, ...(options.appModules ?? []), captureProxyModule);
   container.load(options.serverModule);
   // After the serverModule, which binds `GLSPServer`: the override rebinds that
   // symbol, so it needs the binding to exist. The launchers reach the same tier
   // by passing this to `configure` — a harness that skipped it would answer
   // request failures differently from every real bringup.
   container.load(createGlspServerOverrides());
   const server = container.get<GLSPServer>(GLSPServer);

   let sessionContainer: interfaces.Container | undefined;
   let state: TState | undefined;
   let disposed = false;

   return {
      server,
      container,
      actions,
      get sessionContainer(): interfaces.Container {
         if (!sessionContainer) {
            throw new Error('makeGlspHarness: sessionContainer is only available after start()');
         }
         return sessionContainer;
      },
      get state(): TState {
         if (!state) {
            throw new Error('makeGlspHarness: state is only available after start()');
         }
         return state;
      },

      async start(): Promise<void> {
         await server.initialize({ applicationId, protocolVersion: DefaultGLSPServer.PROTOCOL_VERSION });
         await server.initializeClientSession({ clientSessionId, diagramType: options.diagramType, clientActionKinds });
         const session = container.get<ClientSessionManager>(ClientSessionManager).getSession(clientSessionId);
         if (!session) {
            throw new Error(`makeGlspHarness: no client session '${clientSessionId}' after initializeClientSession`);
         }
         // `session.container` is inversify's concrete `Container`, a nominal type via its
         // private fields — so it clashes across inversify's CJS/ESM dual-package
         // declarations. Typing the harness's container fields as the structural
         // `interfaces.Container` reconciles them with no cast (interfaces compare
         // structurally; the concrete `Container` is only needed for `new Container()`).
         const resolved = session.container;
         sessionContainer = resolved;
         state = resolved.get<TState>(ModelState);
      },

      async shutdown(): Promise<void> {
         server.shutdown();
      },

      dispatch(action: Action): void {
         server.process({ clientId: clientSessionId, action });
      },

      nextAction<T extends Action = Action>(kind: string, timeoutMs = 2000): Promise<T> {
         return waitFor([kind], timeoutMs, true) as Promise<T>;
      },

      async openDocument(sourceUri: string, timeoutMs = 2000): Promise<Action> {
         if (!state) {
            throw new Error('makeGlspHarness: openDocument() is only valid after start()');
         }
         server.process({
            clientId: clientSessionId,
            action: RequestModelAction.create({ options: { [SOURCE_URI_ARG]: sourceUri } })
         });
         const submission = await waitFor(MODEL_SUBMISSION_KINDS, timeoutMs, true);
         // `waitFor` with rejectOnTimeout only resolves with a real action.
         return submission as Action;
      },

      nextModelSubmission(options: NextModelSubmissionOptions = {}): Promise<Action | undefined> {
         const { timeoutMs = 2000, rejectOnTimeout = true } = options;
         return waitFor(MODEL_SUBMISSION_KINDS, timeoutMs, rejectOnTimeout);
      },

      seedSourceRoot(uri: string, root: Parameters<TState['setSourceRoot']>[1]): void {
         if (!state) {
            throw new Error('makeGlspHarness: seedSourceRoot() is only valid after start()');
         }
         state.setSourceRoot(uri, root);
      },

      dispose(): void {
         if (disposed) {
            return;
         }
         disposed = true;
         server.shutdown();
         container.unbindAll();
      }
   };
}
