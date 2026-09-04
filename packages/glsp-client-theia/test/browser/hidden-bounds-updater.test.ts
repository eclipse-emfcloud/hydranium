/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The real `@hydranium/client-theia/browser` module loads `@theia/output` → DOM
// globals unavailable in the node test env. The updater is constructed directly,
// never via a container, so token stand-ins do.
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {},
   ChannelTracer: Symbol('ChannelTracer')
}));

import {
   type Action,
   type ElementAndRoutingPoints,
   ComputedBoundsAction,
   GEdge,
   GGraph,
   GNode,
   LocalRequestBoundsAction,
   Point,
   RequestBoundsAction,
   ServerAction,
   createFeatureSet
} from '@eclipse-glsp/client';
import { type Clock } from '@hydranium/protocol';
// `lib/` subpath, not the `./testing` export: this package compiles with classic
// `moduleResolution: Node`, which does not read the exports map.
import { makeFakeClock } from '@hydranium/protocol/lib/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type VNode } from 'snabbdom';
import { HydraniumHiddenBoundsUpdater } from '../../src/browser/hidden-bounds-updater';

/**
 * A {@link Clock} reporting a caller-controlled duration from `measure`, so the
 * `getBBox=Nms` field is deterministic. `makeFakeClock` alone cannot do it: its
 * virtual time only moves via `advance`, and nothing can advance it from inside
 * the measured callback (that callback is the inherited DOM pass).
 */
function measuringClock(elapsedMs: () => number): Clock {
   const measure = (callback: () => unknown): unknown => ({ result: callback(), elapsedMs: elapsedMs() });
   return { ...makeFakeClock(), measure: measure as Clock['measure'] };
}

/**
 * Runs the **real** `GLSPHiddenBoundsUpdater` / sprotty base implementations
 * against a real `GGraph` model, with only the injected collaborators stubbed —
 * the same style as the loader and dispatcher tests. So the subclass is exercised
 * through the actual `decorate` → `calcElementAndRoute` and `postUpdate` →
 * `getBoundsFromDOM` → dispatch paths rather than against an imitation of them.
 *
 * A DOM is not needed: `getBoundsFromDOM` skips any entry whose vnode carries no
 * `elm`, which is every entry these tests produce.
 */
class TestableUpdater extends HydraniumHiddenBoundsUpdater {
   /** `trace` lines the updater emitted, in order. */
   readonly traceLines: string[] = [];
   readonly dispatched: Action[] = [];
   /** Virtual duration `clock.measure` reports for the measurement pass. */
   measurementMs = 0;

   protected override readonly clock: Clock = measuringClock(() => this.measurementMs);

   constructor() {
      super();
      (this as unknown as { channel: unknown }).channel = {
         trace: (message: string) => this.traceLines.push(message)
      };
      (this as unknown as { layouter: unknown }).layouter = { layout: () => undefined };
      (this as unknown as { actionDispatcher: unknown }).actionDispatcher = {
         dispatch: (action: Action) => {
            this.dispatched.push(action);
            return Promise.resolve();
         }
      };
      (this as unknown as { editorContext: unknown }).editorContext = { canvasBounds: undefined, viewportData: undefined };
   }

   /** Install an edge-router registry so the base `decorate` computes a route
    *  through `calcRoute` — the only path that can produce a degenerate one. */
   useRouterReturning(points: ReadonlyArray<{ x: number; y: number }>): void {
      (this as unknown as { edgeRouterRegistry: unknown }).edgeRouterRegistry = {
         get: () => ({ route: () => points.map(point => ({ kind: 'linear', ...point })) })
      };
   }

   exposeRoutes(): ElementAndRoutingPoints[] {
      return this.element2route;
   }

   exposeCurrentScope(): string | undefined {
      return this.currentScope;
   }

   exposeGetBoundsFromDOM(): void {
      this.getBoundsFromDOM();
   }
}

/** A vnode with no `elm`, so the base measurement pass records the entry but
 *  reads no geometry. */
const DETACHED_VNODE = {} as VNode;

/**
 * A node with its default feature set applied. `new GNode()` alone leaves
 * `features` undefined — the real model factory assigns it — and `hasFeature` then
 * answers `false` for everything, so sprotty's `isSizeable` check would skip the
 * node and nothing would be measured.
 */
function makeGNode(id: string, position: Point): GNode {
   const node = new GNode();
   node.id = id;
   node.type = 'node';
   node.position = position;
   node.size = { width: 10, height: 10 };
   node.features = createFeatureSet(GNode.DEFAULT_FEATURES);
   return node;
}

/** Build a `GGraph` with two positioned nodes and an edge between them. The graph
 *  supplies the model index the inherited `source` / `target` getters resolve
 *  through, so the repair sees real anchor positions. */
function makeGraph(options: { sourcePosition?: Point; targetPosition?: Point; routingPoints?: Point[] } = {}): {
   graph: GGraph;
   edge: GEdge;
   nodes: GNode[];
} {
   const graph = new GGraph();
   graph.id = 'root';
   graph.type = 'graph';
   graph.features = createFeatureSet(GGraph.DEFAULT_FEATURES);

   const source = makeGNode('n1', options.sourcePosition ?? { x: 0, y: 0 });
   const target = makeGNode('n2', options.targetPosition ?? { x: 0, y: 0 });

   const edge = new GEdge();
   edge.id = 'edge1';
   edge.type = 'edge';
   edge.sourceId = source.id;
   edge.targetId = target.id;
   edge.routingPoints = options.routingPoints ?? [];
   edge.features = createFeatureSet(GEdge.DEFAULT_FEATURES);

   graph.add(source);
   graph.add(target);
   graph.add(edge);
   return { graph, edge, nodes: [source, target] };
}

/** Add `count` sizeable nodes to `graph` and decorate each, populating the
 *  measurement map exactly as a real render pass would. */
function seedMeasuredNodes(updater: TestableUpdater, graph: GGraph, count: number): void {
   for (let index = 0; index < count; index++) {
      const node = makeGNode(`seed${index}`, { x: 0, y: 0 });
      graph.add(node);
      updater.decorate(DETACHED_VNODE, node);
   }
}

const rootArg = { id: 'root', type: 'graph' };

/**
 * A bounds request as it arrives *from the server*: carrying the
 * `__receivedFromServer` marker `GLSPModelSource` stamps on inbound actions.
 * Without it a plain `RequestBoundsAction.create(...)` is indistinguishable from a
 * client-local one, which is exactly what the updater keys on.
 */
function serverRequest(): Action {
   const action = RequestBoundsAction.create(rootArg);
   ServerAction.mark(action);
   return action;
}

describe('HydraniumHiddenBoundsUpdater', () => {
   let updater: TestableUpdater;

   beforeEach(() => {
      updater = new TestableUpdater();
   });

   describe('instrumentation', () => {
      it('emits exactly one line per bounds request, with the measured count', () => {
         // One line, not a start/done pair: the whole reason this composes its own
         // line from `Clock.measure` instead of using `Tracer.time`.
         const { graph } = makeGraph();
         seedMeasuredNodes(updater, graph, 7);
         updater.measurementMs = 484;
         updater.postUpdate(serverRequest());

         expect(updater.traceLines).toEqual(['bounds-request[server] measured=7 getBBox=484ms']);
      });

      it('reports the count even when the pass is instant', () => {
         // The element count is the diagnostic that attributes a diagram's cost away
         // from measurement, so a sub-millisecond pass must still report.
         const { graph } = makeGraph();
         seedMeasuredNodes(updater, graph, 6);
         updater.postUpdate(serverRequest());
         expect(updater.traceLines).toEqual(['bounds-request[server] measured=6 getBBox=0ms']);
      });

      it('distinguishes a client-local request from a server request', () => {
         updater.postUpdate(LocalRequestBoundsAction.create(rootArg));
         expect(updater.traceLines[0]).toContain('bounds-request[local]');
      });

      it('names the element a scoped request asked for, not how many', () => {
         // A count says nothing here: a scoped request names one element in
         // practice, so it is always 1. The id says WHICH element was re-measured.
         updater.postUpdate(LocalRequestBoundsAction.create(rootArg, ['node0']));
         expect(updater.traceLines[0]).toContain('bounds-request[local scope=node0]');
      });

      it('names several scoped elements', () => {
         updater.postUpdate(LocalRequestBoundsAction.create(rootArg, ['a', 'b', 'c']));
         expect(updater.traceLines[0]).toContain('bounds-request[local scope=a,b,c]');
      });

      it('summarises the tail once a request names more ids than the cap', () => {
         updater.postUpdate(LocalRequestBoundsAction.create(rootArg, ['a', 'b', 'c', 'd', 'e']));
         expect(updater.traceLines[0]).toContain('scope=a,b,c,+2 more');
      });

      it('omits the scope for an unscoped request', () => {
         updater.postUpdate(serverRequest());
         expect(updater.traceLines[0]).not.toContain('scope=');
      });

      it('omits the scope when the request names only the root', () => {
         // Naming the root measures the whole diagram, so the id adds nothing over
         // the absence of a scope tag.
         updater.postUpdate(LocalRequestBoundsAction.create(rootArg, [rootArg.id]));
         expect(updater.traceLines[0]).not.toContain('scope=');
      });

      it('still completes the bounds round trip it instruments', () => {
         // Instrumentation must not swallow the pass: the ComputedBoundsAction is
         // the whole reason `postUpdate` runs.
         updater.postUpdate(serverRequest());
         expect(updater.dispatched.filter(ComputedBoundsAction.is)).toHaveLength(1);
      });

      it('passes a non-bounds cause through without logging it', () => {
         updater.postUpdate({ kind: 'someOtherAction' });
         expect(updater.traceLines).toHaveLength(0);
         expect(updater.dispatched).toHaveLength(0);
      });

      it('does not emit a stray line for a measurement outside a request', () => {
         // A subclass may call the measurement pass directly; with no cause there is
         // nothing to attribute a measurement to.
         updater.exposeGetBoundsFromDOM();
         expect(updater.traceLines).toHaveLength(0);
      });

      it('clears the per-request scope even when the base pass throws', () => {
         const boom = new Error('layout failed');
         (updater as unknown as { layouter: unknown }).layouter = {
            layout: () => {
               throw boom;
            }
         };
         expect(() => updater.postUpdate(serverRequest())).toThrow(boom);
         // A leaked scope would attribute the next direct measurement to this request.
         expect(updater.exposeCurrentScope()).toBeUndefined();
      });
   });

   describe('routing-point repair', () => {
      it('keeps a route the router computed with two or more points', () => {
         const { edge } = makeGraph();
         updater.useRouterReturning([
            { x: 0, y: 0 },
            { x: 10, y: 10 }
         ]);
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()).toEqual([
            {
               elementId: 'edge1',
               newRoutingPoints: [
                  { kind: 'linear', x: 0, y: 0 },
                  { kind: 'linear', x: 10, y: 10 }
               ]
            }
         ]);
      });

      it('repairs the route when duplicate filtering collapses it to one point', () => {
         // The real trigger: while obstacles carry sprotty's unmeasured-bounds
         // sentinel, source and target coincide, so `calcRoute` dedupes a valid
         // two-point route down to one. That result is defined, so upstream's own
         // truthiness guard never fires and the single point would ship.
         const { edge } = makeGraph({ sourcePosition: { x: 5, y: 6 }, targetPosition: { x: 50, y: 60 } });
         updater.useRouterReturning([
            { x: 100, y: 100 },
            { x: 100, y: 100 }
         ]);
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()).toEqual([
            {
               elementId: 'edge1',
               newRoutingPoints: [
                  { x: 5, y: 6 },
                  { x: 50, y: 60 }
               ]
            }
         ]);
      });

      it('repairs an empty route the same way', () => {
         const { edge } = makeGraph({ sourcePosition: { x: 1, y: 2 }, targetPosition: { x: 3, y: 4 } });
         updater.useRouterReturning([]);
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()[0].newRoutingPoints).toEqual([
            { x: 1, y: 2 },
            { x: 3, y: 4 }
         ]);
      });

      it('keeps the element own bendpoints between the anchors', () => {
         const { edge } = makeGraph({
            sourcePosition: { x: 0, y: 0 },
            targetPosition: { x: 40, y: 40 },
            routingPoints: [{ x: 20, y: 20 }]
         });
         updater.useRouterReturning([{ x: 100, y: 100 }]);
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()[0].newRoutingPoints).toEqual([
            { x: 0, y: 0 },
            { x: 20, y: 20 },
            { x: 40, y: 40 }
         ]);
      });

      it('falls back to the origin for a dangling source or target reference', () => {
         // A mid-update tree can hold an edge whose endpoints are not (yet) in the
         // index; `index.getById` then answers undefined and the anchors are unknown.
         // Same exposure as upstream's own fallback, which reads them the same way.
         const { edge } = makeGraph();
         edge.sourceId = 'missing-source';
         edge.targetId = 'missing-target';
         updater.useRouterReturning([]);
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()[0].newRoutingPoints).toEqual([Point.ORIGIN, Point.ORIGIN]);
      });

      it('leaves a non-routable element alone', () => {
         const { nodes } = makeGraph();
         updater.decorate(DETACHED_VNODE, nodes[0]);
         expect(updater.exposeRoutes()).toEqual([]);
      });

      it('does not repair when no router is configured', () => {
         // Without a registry the base takes its own source/target fallback, which is
         // already valid — the repair must be a no-op rather than a second rewrite.
         const { edge } = makeGraph({ sourcePosition: { x: 7, y: 8 }, targetPosition: { x: 9, y: 10 } });
         updater.decorate(DETACHED_VNODE, edge);
         expect(updater.exposeRoutes()[0].newRoutingPoints).toEqual([
            { x: 7, y: 8 },
            { x: 9, y: 10 }
         ]);
      });
   });
});
