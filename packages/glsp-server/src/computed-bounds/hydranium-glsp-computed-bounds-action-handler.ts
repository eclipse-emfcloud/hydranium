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
   type ComputedBoundsAction,
   ComputedBoundsActionHandler,
   type GModelRoot,
   type MaybePromise
} from '@eclipse-glsp/server';
import { type AstNode } from '@hydranium/langium';
import { injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { type HydraniumGlspSubmissionHandler } from '../submission/hydranium-glsp-submission-handler.js';

/**
 * GLSP {@link ComputedBoundsActionHandler} base shared by all hydranium
 * adopters. Adds handshake-aware revision-mismatch logging on top of the
 * upstream handler.
 *
 * **Why the lift.** GLSP's base silently returns `[]` on a revision
 * mismatch — benign for stale post-drag bounds (the user moved an element,
 * the server-side GModel got re-rendered before the client's pre-move
 * `computedBounds` arrived; dropping the stale frame is correct). But
 * catastrophic during the initial `requestModel → setModel` handshake: if the
 * very first `computedBounds` arrives with a revision the server has already
 * bumped, the subsequent `SetModelAction` response never fires and the diagram
 * stays stuck at "model loading…". Adopters need this initial-handshake case
 * surfaced as a warning so the failure mode is visible in logs.
 *
 * **Handshake detection** uses
 * {@link HydraniumGlspSubmissionHandler.hasPendingInitialRequest} — true
 * while a `RequestModelAction` has been accepted but the corresponding
 * `SetModelAction` has not yet been dispatched. Adopters that override
 * `submitModel` flow must preserve the `hasPendingInitialRequest` semantics
 * for this logging to remain accurate.
 *
 * **Customisation.** The class is shipped non-abstract because the default
 * body fits common adopters, which bind it directly. Adopters with
 * bounds-specific cleanup subclass and override `applyBounds`.
 */
@injectable()
export class HydraniumGlspComputedBoundsActionHandler extends ComputedBoundsActionHandler {
   declare protected readonly modelState: AbstractHydraniumGlspState<AstNode, unknown>;
   declare protected readonly submissionHandler: HydraniumGlspSubmissionHandler<AstNode, unknown>;

   override execute(action: ComputedBoundsAction): MaybePromise<Action[]> {
      this.modelState.logger.debug(`ComputedBoundsActionHandler.execute entered: action.revision=${action.revision}`);
      const model = this.modelState.root;
      if (action.revision !== model.revision) {
         if (this.submissionHandler.hasPendingInitialRequest()) {
            this.modelState.logger.warn(
               `ComputedBounds rejected (initial handshake): action.revision=${action.revision} model.revision=${model.revision} — ` +
                  'initial SetModelAction will not fire (empty diagram)'
            );
         } else {
            this.modelState.logger.debug(
               `ComputedBounds dropped (stale): action.revision=${action.revision} model.revision=${model.revision} — ` +
                  'bounds belong to a superseded GModel; safe to ignore'
            );
         }
         return [];
      }
      this.modelState.logger.trace(`ComputedBounds accepted: revision=${action.revision}, bounds=${action.bounds?.length ?? 0}`);
      return super.execute(action);
   }

   /**
    * Defensively filter routes that lack the source+target endpoints upstream
    * `applyRoute` requires (`newRoutingPoints.length >= 2`). Without this,
    * the upstream handler throws `GLSPServerError: Invalid Route!` and the
    * entire `computedBounds` action is rejected — the diagram never settles.
    *
    * The race that produces these routes is benign and common on the
    * initial layout pass: the GModel factory emits an edge with no explicit
    * `routingPoints`, the client schedules the edge for routing but submits
    * `computedBounds` before the routing pass finishes, so the route shows
    * up with 0 or 1 point. Subsequent `computedBounds` actions carry the
    * fully-routed edges; dropping the incomplete ones here is lossless.
    *
    * Adopters with bounds-specific cleanup — clearing ALL routes so the client
    * re-routes on the next layout, say — override and replace this filter.
    */
   protected override applyBounds(root: GModelRoot, action: ComputedBoundsAction): void {
      if (action.routes && action.routes.length > 0) {
         const original = action.routes.length;
         action.routes = action.routes.filter(route => (route.newRoutingPoints?.length ?? 0) >= 2);
         const dropped = original - action.routes.length;
         if (dropped > 0) {
            this.modelState.logger.debug(
               `ComputedBounds dropped ${dropped}/${original} route(s) with <2 routing points — client hasn't finished routing yet`
            );
         }
      }
      super.applyBounds(root, action);
   }
}
