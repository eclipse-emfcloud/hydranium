/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, DefaultActionDispatcher } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { type Tracer } from '@hydranium/protocol';
import { type GlspClientLogger } from '../logging/glsp-client-logger.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * Server-side action dispatcher with built-in traffic observability:
 * every {@link DefaultActionDispatcher.dispatch} call is wrapped in a
 * {@link Tracer.time} pair that records the dispatch direction
 * (`→ client` vs `→ server`) and timing.
 *
 * **Why this lives in the framework (vs left as an adopter override).**
 * Debugging GLSP state, storage, and submission flows depends heavily on
 * seeing each action with timing and direction — especially when bringing
 * up a new adopter against an empty/partial diagram before its submission
 * flow is complete. Providing this dispatcher in the framework gives every
 * adopter the same observability primitive from the very first GLSP-head
 * launch.
 *
 * **Extension points.**
 * - {@link loggedKinds} — if set, filter the log lines (the dispatch
 *   still happens; only the bracketed timing line is suppressed). Default
 *   `undefined` means **every** action's dispatch is timed and logged.
 * - {@link summarize} — return a non-empty string to append `[summary]`
 *   to the log line; default returns `''` (no extra bracket).
 *
 * Adopters bind it in a per-diagram module, as the `ActionDispatcher` service.
 */
@injectable()
export class HydraniumGlspServerActionDispatcher extends DefaultActionDispatcher {
   /** Narrowed from `Logger`; DI binds {@link GlspClientLogger}. */
   declare protected readonly logger: GlspClientLogger;

   /** Caller-tagged tracer (auto-componented with this class name, like the logger). */
   @inject(HydraniumTypes.Tracer) protected readonly tracer!: Tracer;

   /**
    * If set, the timing log line is emitted only when `action.kind` is in
    * this set. Subclasses override via field reassignment.
    */
   protected readonly loggedKinds: ReadonlySet<string> | undefined = undefined;

   /**
    * Override to enrich the log line with payload-specific detail. Return an
    * empty string to suppress the bracket. Default returns `''`.
    */
   protected summarize(_action: Action): string {
      return '';
   }

   override dispatch(action: Action): Promise<void> {
      if (this.loggedKinds && !this.loggedKinds.has(action.kind)) {
         return super.dispatch(action);
      }
      const direction = this.clientActionForwarder.shouldForwardToClient(action) ? '→ client' : '→ server';
      const summary = this.summarize(action);
      const label = summary
         ? `Dispatch action '${action.kind}' ${direction} [${summary}]`
         : `Dispatch action '${action.kind}' ${direction}`;
      return this.tracer.time(label, () => super.dispatch(action));
   }
}
