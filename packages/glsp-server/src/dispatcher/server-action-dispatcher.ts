/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, CheckEdgeResultAction, DefaultActionDispatcher } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { Logger, type Tracer } from '@hydranium/protocol';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * Server-side action dispatcher with built-in traffic observability: while
 * debug is enabled, each {@link DefaultActionDispatcher.dispatch} call runs
 * inside {@link Tracer.time}, which logs it with its direction (`→ client` vs
 * `→ server`) and timing only when it is slow or fails, and an action that
 * {@link summarize} details gets its own debug line whatever its duration.
 *
 * **Why this lives in the framework (vs left as an adopter override).**
 * Debugging GLSP state, storage, and submission flows depends heavily on
 * seeing slow or failing actions with timing and direction — especially when
 * bringing up a new adopter against an empty/partial diagram before its
 * submission flow is complete. Providing this dispatcher in the framework
 * gives every adopter the same observability primitive from the very first
 * GLSP-head launch.
 *
 * **Extension points.**
 * - {@link loggedKinds} — if set, filter the log lines (the dispatch
 *   still happens; only its timing and summary lines are suppressed).
 *   Default `undefined` times every action's dispatch while debug is enabled.
 * - {@link summarize} — return a non-empty string to log it as a debug line
 *   for the dispatch; `''` logs none.
 */
@injectable()
export class HydraniumGlspServerActionDispatcher extends DefaultActionDispatcher {
   /** Caller-tagged tracer (auto-componented with this class name, like the logger). */
   @inject(HydraniumTypes.Tracer) protected readonly tracer!: Tracer;

   /**
    * If set, the timing and summary lines are emitted only when `action.kind`
    * is in this set. Subclasses override via field reassignment.
    */
   protected readonly loggedKinds: ReadonlySet<string> | undefined = undefined;

   /**
    * Payload detail logged at debug before the dispatch, as
    * `Dispatch action '<kind>' <direction> [<summary>]`, on every dispatch,
    * fast or slow; `''` logs no line. The default details only an action whose
    * outcome the log otherwise loses, each through a `format*` method. Called
    * only when debug is enabled, so it may serialise the payload.
    */
   protected summarize(action: Action): string {
      if (CheckEdgeResultAction.is(action)) {
         return this.formatEdgeCheck(action);
      }
      return '';
   }

   /** An edge check's verdict, so the log shows whether the server let an edge tool connect. */
   protected formatEdgeCheck(action: CheckEdgeResultAction): string {
      return `edgeType=${action.edgeType} source=${action.sourceElementId} target=${action.targetElementId ?? 'none'} isValid=${action.isValid}`;
   }

   /**
    * Whether a request this dispatcher sent, under `requestId`, still awaits
    * its response: not yet answered, and not given up on at its timeout.
    */
   awaitsResponse(requestId: string): boolean {
      return this.pendingRequests.has(requestId);
   }

   override dispatch(action: Action): Promise<void> {
      if (!Logger.isLevelEnabled('debug') || (this.loggedKinds && !this.loggedKinds.has(action.kind))) {
         return super.dispatch(action);
      }
      const direction = this.clientActionForwarder.shouldForwardToClient(action) ? '→ client' : '→ server';
      const label = `Dispatch action '${action.kind}' ${direction}`;
      const summary = this.summarize(action);
      if (summary) {
         // Its own line: `time` is silent on a fast success.
         this.tracer.debug(`${label} [${summary}]`);
      }
      return this.tracer.time(label, () => super.dispatch(action), 'debug');
   }
}
