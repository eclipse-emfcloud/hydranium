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
   type ElementAndRoutingPoints,
   type GModelElement,
   type GRoutableElement,
   GLSPHiddenBoundsUpdater,
   type LocalRequestBoundsAction,
   Point,
   RequestBoundsAction,
   ServerAction,
   isRoutable
} from '@eclipse-glsp/client';
import { ChannelLogger } from '@hydranium/client-theia/lib/browser';
import { type Clock, SystemClock } from '@hydranium/protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import { type VNode } from 'snabbdom';

/** How many scoped element ids the log line names before summarising the rest.
 *  A scoped request names one element in practice; the cap only stops a
 *  pathological caller from writing a thousand ids into the channel. */
const SCOPE_ID_CAP = 3;

/**
 * Instruments sprotty's hidden-bounds pass and repairs degenerate routes before
 * they go on the wire.
 *
 * **Why the framework owns this.** Every GLSP head runs the hidden-bounds pass on
 * every model update, and it is the one client-side phase that scales with the
 * *rendered element count* rather than the model size — labels, compartments and
 * edge decorations expand a modest node count into orders of magnitude more DOM
 * elements. Without a timing line there is no way to tell a slow measurement pass
 * apart from slow edge routing or a slow server round trip; with one,
 * `bounds-request` either exonerates the client in a sentence or names the
 * dominant cost.
 *
 * Emits exactly one `trace` line per bounds request — `trace` because the
 * frequency matches the per-action traffic `HydraniumGlspActionDispatcher` logs
 * there (a bounds request is driven by those actions), so it belongs with them
 * rather than above them. The line carries:
 *
 *  - `server` / `local` — whether the request came from the server or from a
 *    client-local {@link LocalRequestBoundsAction}
 *  - `scope=<ids>` — the elements a scoped request named; absent when the request
 *    covers the whole diagram
 *  - `measured=N` — DOM elements whose bounds were read. Exceeds the scoped id
 *    count because the base class expands each requested element to its
 *    descendants
 *  - `getBBox=Nms` — {@link getBoundsFromDOM} **only**: the layout pass and the
 *    `ComputedBoundsAction` assembly stay outside it, so the number isolates raw
 *    measurement cost
 *
 * Composed from {@link Clock.measure} rather than `Tracer.time`, matching
 * `HydraniumDocumentBuilder`'s phase instrumentation. `Tracer.time` is for "tell
 * me when this is slow" and is deliberately silent on a fast success, which would
 * drop the element count on every normal pass — and forcing it to emit costs a
 * paired `[#N start]` line per request. This is a per-occurrence record, so it
 * measures and composes its own line.
 *
 * Bound by `createGlspClientTheiaModule` via `rebind(GLSPHiddenBoundsUpdater)`.
 */
@injectable()
export class HydraniumHiddenBoundsUpdater extends GLSPHiddenBoundsUpdater {
   @inject(ChannelLogger) protected readonly channel!: ChannelLogger;

   /** Not injected: the browser container binds no {@link Clock}, and this only
    *  measures — no logic is gated on time, so there is nothing to fake in
    *  production. Overridden in tests for a deterministic elapsed value. */
   protected readonly clock: Clock = new SystemClock();

   /**
    * Scope description for the in-flight request, read from the `cause` in
    * {@link postUpdate} and consumed by {@link getBoundsFromDOM} — which the base
    * class calls with no arguments, so the cause cannot be threaded through.
    */
   protected currentScope?: string;

   override decorate(vnode: VNode, element: GModelElement): VNode {
      super.decorate(vnode, element);
      if (isRoutable(element)) {
         this.repairLastRoute(element);
      }
      return vnode;
   }

   /**
    * Replace the routing entry the base class just pushed when it carries fewer
    * than two points, which is not a valid route for any edge.
    *
    * `calcElementAndRoute` already guards the case where the registered router
    * returns *nothing* — it falls back to source + own routing points + target.
    * The hole is one step further in: `calcRoute` filters duplicate points at
    * `Number.EPSILON`, so while obstacles still carry sprotty's unmeasured-bounds
    * sentinel `(100, 100, -1, -1)` the source and target coincide and a valid
    * two-point route collapses to a single point. That result is defined, so the
    * upstream truthiness guard never fires and the single point ships.
    *
    * The substitute is deliberately upstream's own fallback shape rather than a
    * new invention, so a repaired route is indistinguishable from a route the
    * base class would have produced had it noticed. Only already-invalid payloads
    * are touched, so a head with a working router is unaffected.
    */
   protected repairLastRoute(element: GRoutableElement): void {
      const addedRoute = this.element2route.pop();
      if (addedRoute === undefined) {
         return;
      }
      this.element2route.push(this.hasValidRoute(addedRoute) ? addedRoute : this.toSourceTargetRoute(element));
   }

   /** A route needs at least a start and an end point to describe an edge. */
   protected hasValidRoute(route: ElementAndRoutingPoints): boolean {
      return route.newRoutingPoints !== undefined && route.newRoutingPoints.length >= 2;
   }

   /** Upstream's `calcElementAndRoute` no-router fallback: the element's own
    *  bendpoints framed by its source and target anchor positions. */
   protected toSourceTargetRoute(element: GRoutableElement): ElementAndRoutingPoints {
      return {
         elementId: element.id,
         newRoutingPoints: [element.source?.position ?? Point.ORIGIN, ...element.routingPoints, element.target?.position ?? Point.ORIGIN]
      };
   }

   protected override getBoundsFromDOM(): void {
      if (this.currentScope === undefined) {
         // Not inside an instrumented `postUpdate` (a subclass calling directly);
         // with no cause there is nothing to attribute a measurement to.
         super.getBoundsFromDOM();
         return;
      }
      // Read before the pass: the base class clears the map on its way out.
      const measured = this.getElement2BoundsData().size;
      const { elapsedMs } = this.clock.measure(() => super.getBoundsFromDOM());
      this.channel.trace(this.formatBoundsRequest(this.currentScope, measured, elapsedMs));
   }

   /** Format the per-request line. Override to change the wording. */
   protected formatBoundsRequest(scope: string, measured: number, elapsedMs: number): string {
      return `bounds-request[${scope}] measured=${measured} getBBox=${elapsedMs.toFixed(0)}ms`;
   }

   override postUpdate(cause?: Action): void {
      if (cause?.kind !== RequestBoundsAction.KIND) {
         super.postUpdate(cause);
         return;
      }
      this.currentScope = this.formatCause(cause);
      try {
         super.postUpdate(cause);
      } finally {
         this.currentScope = undefined;
      }
   }

   /**
    * Scope facts for the log line: where the request came from, and which
    * elements it asked for.
    *
    * Origin is read from {@link ServerAction}, the `__receivedFromServer` marker
    * `GLSPModelSource` stamps on inbound actions, rather than from
    * `LocalRequestBoundsAction.is`. The latter would answer the same today, but
    * only incidentally: its `elementIDs` check is declared optional, so it is
    * really just "a bounds request that did not come from the server". Keying on
    * the marker states that directly, and keeps an *unscoped* local request from
    * being mislabelled `server` if GLSP ever tightens that guard.
    */
   protected formatCause(cause: Action): string {
      const origin = ServerAction.is(cause) ? 'server' : 'local';
      const scope = this.formatScope(cause as RequestBoundsAction);
      return scope ? `${origin} scope=${scope}` : origin;
   }

   /**
    * Name the elements a scoped request asked for, or `undefined` when it covers
    * the whole diagram.
    *
    * Deliberately the ids and not their count. A scoped request in practice names
    * a single element, so a count is always `1` and says nothing, while the id
    * says *which* element was re-measured — and it is the only part of the line
    * that distinguishes one such request from the next. It also stops the line
    * reading as a contradiction: `scope=node0, measured=6` is coherent (the base
    * class expands a requested element to its descendants, so one id measures six
    * DOM elements), where `scoped=1, measured=6` invites the reader to wonder
    * which number is wrong.
    *
    * A request naming only the root is treated as unscoped: it measures
    * everything, so the id adds nothing over the absence of a `scope` tag.
    */
   protected formatScope(cause: RequestBoundsAction): string | undefined {
      const scopedIds = (cause as LocalRequestBoundsAction).elementIDs;
      if (!scopedIds || scopedIds.length === 0) {
         return undefined;
      }
      const named = scopedIds.filter(id => id !== cause.newRoot?.id);
      if (named.length === 0) {
         return undefined;
      }
      if (named.length > SCOPE_ID_CAP) {
         return `${named.slice(0, SCOPE_ID_CAP).join(',')},+${named.length - SCOPE_ID_CAP} more`;
      }
      return named.join(',');
   }
}
