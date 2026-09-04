/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   ComputedBoundsAction,
   GLSPActionDispatcher,
   GLSPModelSource,
   LocalComputedBoundsAction,
   MessageAction,
   RejectAction,
   RequestAction,
   RequestBoundsAction,
   RequestContextActions,
   RequestModelAction,
   RequestTypeHintsAction,
   ResponseAction,
   ServerAction,
   SetDirtyStateAction,
   SetEditModeAction,
   SetMarkersAction,
   SetModelAction,
   SetTypeHintsAction,
   StatusAction,
   UpdateModelAction
} from '@eclipse-glsp/client';
import { ChannelLogger, ChannelTracer } from '@hydranium/client-theia/lib/browser';
import { type Tracer } from '@hydranium/protocol';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';

/** Default subset of action kinds the framework dispatcher will log: the GLSP
 *  traffic an observer reading the Output channel typically wants to see. All
 *  are standard `@eclipse-glsp/client` kinds; adopters with custom action kinds
 *  extend via `extraLoggedKinds`. */
export const HYDRANIUM_DEFAULT_LOGGED_KINDS: ReadonlySet<string> = new Set<string>([
   SetModelAction.KIND,
   UpdateModelAction.KIND,
   RequestBoundsAction.KIND,
   ComputedBoundsAction.KIND,
   SetDirtyStateAction.KIND,
   SetEditModeAction.KIND,
   SetMarkersAction.KIND,
   SetTypeHintsAction.KIND,
   StatusAction.KIND,
   MessageAction.KIND,
   RejectAction.KIND,
   RequestContextActions.KIND,
   RequestModelAction.KIND,
   RequestTypeHintsAction.KIND
]);

/** Default request → response kind pairs for GLSP 'flow' actions that do NOT
 *  carry a requestId/responseId — so the dispatcher matches by kind (FIFO).
 *  Id-based matching still wins when a requestId is present. */
export const HYDRANIUM_DEFAULT_KIND_PAIRS: ReadonlyMap<string, string> = new Map<string, string>([
   [RequestModelAction.KIND, SetModelAction.KIND],
   [RequestTypeHintsAction.KIND, SetTypeHintsAction.KIND],
   [RequestBoundsAction.KIND, ComputedBoundsAction.KIND]
]);

/** Additive options. Adopters with custom action kinds pass extras here; the
 *  framework defaults always apply (you cannot un-log a kind the framework
 *  considers worth logging — subclass + override `dispatch` if you must). */
export interface HydraniumGlspActionDispatcherOptions {
   readonly extraLoggedKinds?: Iterable<string>;
   readonly extraKindPairs?: Iterable<readonly [string, string]>;
   /** Replaces the default `summarize` body entirely. Use for adopter-domain
    *  action kinds where the framework default returns ''. */
   readonly summarize?: (action: Action) => string;
}

/**
 * Wraps every dispatch so action traffic appears in the framework Output
 * channel, interleaved with server log lines. Instrumenting the dispatcher
 * (rather than per-kind handlers) catches ResponseActions that bypass the
 * handler pipeline.
 *
 * The framework defaults cover the standard GLSP kinds worth logging, not every
 * kind the protocol defines. Adopters with custom kinds either pass
 * `extraLoggedKinds` / `extraKindPairs` to the constructor (via a
 * `toDynamicValue` binding) or subclass and override.
 */
@injectable()
export class HydraniumGlspActionDispatcher extends GLSPActionDispatcher {
   @inject(ChannelLogger) protected readonly channel!: ChannelLogger;
   @inject(ChannelTracer) protected readonly tracer!: Tracer;

   protected readonly loggedKinds: ReadonlySet<string>;
   protected readonly kindPairs: ReadonlyMap<string, string>;
   protected readonly kindPairsReverse: ReadonlyMap<string, string>;

   protected pairCounter = 0;
   /** Pending requests keyed by requestId (for actions that carry one). */
   protected pendingById = new Map<string, { id: number; start: number }>();
   /** FIFO queue per response kind, used for `flow` pairs without requestId/responseId. */
   protected pendingByKind = new Map<string, Array<{ id: number; start: number }>>();

   constructor(@unmanaged() options?: HydraniumGlspActionDispatcherOptions) {
      super();
      const extraLogged = options?.extraLoggedKinds ? Array.from(options.extraLoggedKinds) : [];
      this.loggedKinds = new Set<string>([...HYDRANIUM_DEFAULT_LOGGED_KINDS, ...extraLogged]);
      const extraPairs = options?.extraKindPairs ? Array.from(options.extraKindPairs) : [];
      const pairs = new Map<string, string>([...HYDRANIUM_DEFAULT_KIND_PAIRS, ...extraPairs]);
      this.kindPairs = pairs;
      this.kindPairsReverse = new Map<string, string>(Array.from(pairs, ([req, res]) => [res, req]));
      if (options?.summarize) {
         this.summarize = options.summarize;
      }
   }

   override initialize(): Promise<void> {
      // `initialize()` is called many times; super is idempotent, but our callback registration
      // isn't. Register the timing log only on the first call (when super.initialized is unset).
      if (!this.initialized) {
         this.registerInitTiming();
      }
      return super.initialize();
   }

   /**
    * Register the one-shot 'model initialized' timing line. Instrumentation
    * only — guarded so a tracer failure degrades logging rather than aborting
    * diagram init. `initialize()` runs inside `DiagramLoader.load()`, whose
    * caller (`GLSPDiagramWidget.onAfterAttach`) neither awaits nor catches the
    * returned promise; an error thrown here would therefore escape as an
    * uncaught rejection that blanks the diagram with no server-side signal.
    */
   protected registerInitTiming(): void {
      try {
         this.tracer.time('Model initialized', () => this.onceModelInitialized(), 'info', { logAfterMs: 0 });
      } catch (err) {
         this.channel.error('Failed to register model-initialized timing instrumentation', err);
      }
   }

   override dispatch(action: Action): Promise<void> {
      if (this.loggedKinds.has(action.kind)) {
         this.logAction(action);
      }
      return super.dispatch(action);
   }

   protected logAction(action: Action): void {
      const { verb, direction } = this.classify(action);
      const summary = this.summarize(action);
      const timing = this.trackPair(action);
      const parts = [`${verb} action '${action.kind}'`, `[${direction}]`];
      if (summary) {
         parts.push(`[${summary}]`);
      }
      if (timing) {
         parts.push(timing);
      }
      this.channel.trace(parts.join(' '));
   }

   protected classify(action: Action): { verb: string; direction: string } {
      // GLSP marks client-produced computedBounds as ServerAction to suppress forwarding; stays local.
      if (LocalComputedBoundsAction.is(action)) {
         return { verb: 'Process', direction: 'client → client' };
      }
      // Marked by GLSPModelSource.messageReceived — arrived from the server.
      if (ServerAction.is(action)) {
         return { verb: 'Receive', direction: 'server → client' };
      }
      // GLSPModelSource is registered as handler for every server-handled kind (configureServeActions),
      // so its presence means the action will be forwarded to the server.
      const handlers = this.actionHandlerRegistry.get(action.kind);
      if (handlers.some(handler => handler instanceof GLSPModelSource)) {
         return { verb: 'Send', direction: 'client → server' };
      }
      return { verb: 'Process', direction: 'client → client' };
   }

   /** Emit `[request #N]` on the request side, `[response #N, Xms]` on the matching response side.
    *  Match first by requestId/responseId, then by known kind pairs (FIFO). */
   protected trackPair(action: Action): string {
      // Response side.
      if (ResponseAction.hasValidResponseId(action)) {
         const entry = this.pendingById.get(action.responseId);
         if (entry) {
            this.pendingById.delete(action.responseId);
            return this.formatResponse(entry);
         }
      }
      if (this.kindPairsReverse.has(action.kind)) {
         const queue = this.pendingByKind.get(action.kind);
         const entry = queue?.shift();
         if (entry) {
            return this.formatResponse(entry);
         }
      }
      // Request side.
      if (RequestAction.is(action) && action.requestId) {
         const entry = { id: ++this.pairCounter, start: performance.now() };
         this.pendingById.set(action.requestId, entry);
         return `[request #${entry.id}]`;
      }
      if (this.kindPairs.has(action.kind)) {
         const responseKind = this.kindPairs.get(action.kind)!;
         const entry = { id: ++this.pairCounter, start: performance.now() };
         const queue = this.pendingByKind.get(responseKind) ?? [];
         queue.push(entry);
         this.pendingByKind.set(responseKind, queue);
         return `[request #${entry.id}]`;
      }
      return '';
   }

   protected formatResponse(entry: { id: number; start: number }): string {
      const elapsed = Math.round(performance.now() - entry.start);
      return `[response #${entry.id}, ${elapsed}ms]`;
   }

   protected summarize(action: Action): string {
      if (SetModelAction.is(action) || UpdateModelAction.is(action)) {
         const root = action.newRoot;
         return `rootType=${root?.type ?? 'none'} children=${root?.children?.length ?? 0}`;
      }
      if (RequestBoundsAction.is(action)) {
         return `rootType=${action.newRoot.type} children=${action.newRoot.children?.length ?? 0}`;
      }
      if (ComputedBoundsAction.is(action)) {
         return `bounds=${action.bounds.length}`;
      }
      if (SetDirtyStateAction.is(action)) {
         return `isDirty=${action.isDirty} reason=${action.reason ?? 'n/a'}`;
      }
      if (SetEditModeAction.is(action)) {
         return `editMode=${action.editMode}`;
      }
      if (SetMarkersAction.is(action)) {
         return `markers=${action.markers.length}`;
      }
      if (StatusAction.is(action) || MessageAction.is(action)) {
         // severity=NONE with empty message is the conventional 'clear' signal.
         const clear = action.severity === 'NONE' && !action.message ? ' (clear)' : '';
         return `severity=${action.severity} message="${action.message.slice(0, 160)}"${clear}`;
      }
      if (RejectAction.is(action)) {
         return `reason="${action.message.slice(0, 160)}"`;
      }
      if (SetTypeHintsAction.is(action)) {
         return `shapes=${action.shapeHints.length} edges=${action.edgeHints.length}`;
      }
      if (RequestContextActions.is(action)) {
         return `contextId=${action.contextId}`;
      }
      return '';
   }
}
