/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `.process` GModel projection, driven against **real parsed documents**
 * from the sample workspace rather than fixtures — so `transition.source.ref`,
 * `branch.target.ref` and the cross-grammar `effect.entity.ref` are genuinely
 * linked, which is the state the factory is written against.
 *
 * The GLSP `ModelState` is stood in for rather than DI-composed: the factory
 * reads only `sourceUri`, `sourceRoot`, `layoutRoot`, `updateRoot` and the
 * index's `createId` / `registerElementId`, so a stand-in isolates the
 * projection logic — which is what this suite owns. `layoutRoot` is the
 * `.layout` SECONDARY, read as its own parsed document, because the `.process`
 * root carries no layout at all. Harness-level dispatch (RequestModelAction →
 * submission → bounds) and the faithful real-services round-trip are separate
 * concerns.
 *
 * `createId` mirrors the real key scheme rather than inventing a readable one,
 * and that is load-bearing: a stub that keyed a transition by its endpoints
 * (`transition_Pay_PaymentOk`) would give the ids a stability the real scheme
 * lacks, and a double authored from the same assumption as the code it supports
 * cannot falsify it.
 *
 * What runs in production: no `ElementKeyProvider` override, so
 * `DefaultElementKeyProvider` = `NameBasedKeyProvider`, whose fallback for an
 * unnamed node is `` `${$containerProperty}@${$containerIndex}` ``. So a
 * transition is `transitions@0`, and its id moves when its index moves. The
 * stub below reproduces exactly that, so the ids here have the same shape
 * — and the same instability — as the real ones.
 */

import type { GCompartment, GEdge, GGraph, GModelElement, GNode } from '@eclipse-glsp/graph';
import { asMutable } from '@hydranium/protocol';
import type { AstNode } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { OrderFlowProcessGModelFactory } from '../../src/glsp/order-flow-process-gmodel-factory.js';
import {
   PROCESS_BRANCH_EDGE_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from '../../src/glsp/order-flow-process-diagram-types.js';
import { type LayoutModel, type ProcessModel, isTask } from '../../src/language-server/ast.js';
import { documentFor, makeWorkspaceHarness, type OrderFlowHarness } from '../order-flow-harness.js';

/**
 * Stand-in for `NameBasedKeyProvider.getElementKey`: the element's own name
 * when it has one, otherwise the same `containerProperty@containerIndex`
 * fallback the real provider uses.
 *
 * Kept deliberately faithful rather than readable — an unnamed element's id is
 * index-derived in production, and a stub that hid that would let a handler
 * test pass while the real ids shifted underneath it.
 */
function stubId(node?: AstNode): string {
   if (!node) {
      return '';
   }
   const named = node as { name?: string };
   if (typeof named.name === 'string') {
      return named.name;
   }
   if (node.$containerProperty !== undefined && node.$containerIndex !== undefined) {
      return `${node.$containerProperty}@${node.$containerIndex}`;
   }
   return node.$type;
}

/**
 * The layout root for a `.process` path, from its sibling `.layout` document.
 * Throws rather than defaulting when the file is missing: every path this suite
 * uses has one, so an absent document means a mistyped path, and silently
 * substituting an empty layout would turn that into a passing test that proves
 * nothing about positioning.
 */
function layoutRootFor(harness: OrderFlowHarness, processPath: string): LayoutModel {
   return documentFor<LayoutModel>(harness, processPath.replace(/\.process$/, '.layout')).parseResult.value;
}

/** One factory run: the graph it produced plus the reference projections it registered. */
interface FactoryRun {
   readonly graph: GGraph;
   /** `[element key, GModel id]` per {@link OrderFlowProcessGModelFactory} `registerElementId` call, in walk order. */
   readonly registered: ReadonlyArray<readonly [string, string]>;
}

/**
 * Drive the factory over `root` with a stand-in `ModelState`.
 *
 * The stand-in supplies exactly the members the factory reads. Structural, not
 * `any` — a member the factory starts using fails here, at the assignment below,
 * rather than at runtime.
 */
function runFactory(root: ProcessModel, layoutRoot: LayoutModel, sourceUri = 'file:///probe.process'): FactoryRun {
   let captured: GGraph | undefined;
   const registered: Array<readonly [string, string]> = [];
   const state = {
      sourceUri,
      sourceRoot: root,
      layoutRoot,
      index: {
         createId: stubId,
         // The index's REVERSE half: the factory records the `.domain` field an
         // effect label stands for, which is what lets a diagnostic published on
         // that other document reach this diagram. Captured rather than ignored
         // so the projection is observable without DI.
         registerElementId: (element: AstNode, id: string): void => {
            registered.push([stubId(element), id]);
         }
      },
      updateRoot: (graph: GGraph) => {
         captured = graph;
      }
   };
   const factory = new OrderFlowProcessGModelFactory();
   (factory as unknown as { modelState: typeof state }).modelState = state;
   factory.createModel();
   if (!captured) {
      throw new Error('factory did not call updateRoot');
   }
   return { graph: captured, registered };
}

/** Build the graph for a workspace `.process` document. */
async function buildGraph(harness: OrderFlowHarness, relativePath: string): Promise<GGraph> {
   const root = documentFor<ProcessModel>(harness, relativePath).parseResult.value;
   return runFactory(root, layoutRootFor(harness, relativePath), `file:///${relativePath}`).graph;
}

const byType = (graph: GGraph, type: string): GModelElement[] => graph.children.filter(child => child.type === type);

describe('order-flow .process GModel projection', () => {
   it('emits a node per flow node, typed by task vs gateway', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      expect((byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).map(node => node.id)).toEqual(['Pay', 'Pick', 'Ship', 'Cancel']);
      expect((byType(graph, PROCESS_GATEWAY_NODE_TYPE) as GNode[]).map(node => node.id)).toEqual(['PaymentOk']);
   });

   it('puts a task effect line in a compartment, reading reference text', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
      const compartment = pay.children.find(child => child.type === PROCESS_EFFECT_COMPARTMENT_TYPE);
      expect(compartment).toBeDefined();
      // The full three-part cross-grammar effect: entity, field on it, then an
      // enum literal on THAT field's type. Rendered from $refText, so a broken
      // effect shows what the author typed rather than collapsing to blanks.
      expect(compartment!.children.map(label => (label as { text?: string }).text)).toEqual(['writes Order.status = PAID']);
   });

   it('registers each effect label as rendering the .domain field it touches', async () => {
      const harness = await makeWorkspaceHarness();
      const root = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;

      const { registered } = runFactory(root, layoutRootFor(harness, 'orders/fulfillment.process'));

      // The field lives in `orders.domain`, so this registration is the only
      // reason the index reports that document as contributing a rendered
      // element — and therefore the only reason a diagnostic published there can
      // become a marker on this diagram. Four tasks, one effect each, in walk
      // order (the gateway has none); the stub keys by own name, so the pairs
      // read as `[field, effect-label]`.
      expect(registered).toEqual([
         ['status', 'effects@0'],
         ['id', 'effects@0'],
         ['status', 'effects@0'],
         ['status', 'effects@0']
      ]);
   });

   it('omits the compartment for a task with no effects', async () => {
      // The grammar allows `task Pay` with no effects, but every task in the
      // sample workspace has one — checked, not assumed — so the state is
      // constructed here rather than asserted against a fixture that would have
      // made this pass vacuously.
      const harness = await makeWorkspaceHarness();
      const root = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;
      const pay = asMutable(root.nodes.filter(isTask).find(node => node.name === 'Pay')!);
      const effects = pay.effects;
      pay.effects = [];
      try {
         const { graph } = runFactory(root, layoutRootFor(harness, 'orders/fulfillment.process'));

         const node = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(candidate => candidate.id === 'Pay')!;
         expect(node.children.some(child => child.type === PROCESS_EFFECT_COMPARTMENT_TYPE)).toBe(false);
         // Still carries its name label, so the node is not degenerate.
         expect(node.children).toHaveLength(1);
      } finally {
         pay.effects = effects;
      }
   });

   it('emits transition edges between the ids their endpoints were emitted under', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const nodeIds = new Set(graph.children.filter(child => 'children' in child).map(child => child.id));
      const transitions = byType(graph, PROCESS_TRANSITION_EDGE_TYPE) as GEdge[];

      expect(transitions.map(edge => [edge.sourceId, edge.targetId])).toEqual([
         ['Pay', 'PaymentOk'],
         ['Pick', 'Ship']
      ]);
      // The invariant that matters: a GLSP edge naming an id no node carries
      // fails client-side with a far less obvious error than a missing edge.
      for (const edge of transitions) {
         expect(nodeIds.has(edge.sourceId), edge.id).toBe(true);
         expect(nodeIds.has(edge.targetId), edge.id).toBe(true);
      }
   });

   it('emits a labelled branch edge from its owning gateway', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const branches = byType(graph, PROCESS_BRANCH_EDGE_TYPE) as GEdge[];
      expect(branches.map(edge => [edge.sourceId, edge.targetId])).toEqual([
         ['PaymentOk', 'Pick'],
         ['PaymentOk', 'Cancel']
      ]);
      // The label is the branch's own, and it is what distinguishes a branch
      // from a transition — a gateway with unlabelled edges is unreadable.
      expect(branches.map(edge => (edge.children[0] as { text?: string }).text)).toEqual(['yes', 'no']);
   });

   it('skips an edge whose endpoint does not resolve, rather than emitting a dangling id', async () => {
      // Drive the tolerance path with a root whose transition target is
      // unresolvable. Mutating the parsed root directly is the cheapest way to
      // reach it without adding a broken file to the sample workspace, whose
      // only intended error is the visibility negative.
      const harness = await makeWorkspaceHarness();
      const root = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;
      const transition = asMutable(root.transitions[0]);
      const original = transition.target;
      transition.target = { $refText: 'Nowhere', ref: undefined };
      try {
         const { graph } = runFactory(root, layoutRootFor(harness, 'orders/fulfillment.process'));

         const transitions = byType(graph, PROCESS_TRANSITION_EDGE_TYPE) as GEdge[];
         expect(transitions.map(edge => [edge.sourceId, edge.targetId])).toEqual([['Pick', 'Ship']]);
      } finally {
         transition.target = original;
      }
   });

   it('applies persisted bounds from the .layout file', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
      expect(pay.position).toEqual({ x: 40, y: 100 });
      expect(pay.size).toEqual({ width: 160, height: 60 });
      // A gateway too, so the overlay is not accidentally task-only — and this
      // one is the PARTIAL case the overlay exists to support: its entry carries
      // a position and no size, so the position must arrive while the size stays
      // the notation's. `prefWidth` is the channel a persisted size travels, so
      // its absence is what says the entry was applied partially rather than
      // completed with a default.
      const gateway = (byType(graph, PROCESS_GATEWAY_NODE_TYPE) as GNode[])[0];
      expect(gateway.position).toEqual({ x: 260, y: 90 });
      expect(gateway.layoutOptions).not.toHaveProperty('prefWidth');
   });

   /**
    * The diagram configuration sets `layoutKind: NONE` and
    * `needsClientLayout: true`, so sprotty's client-side micro-layout is the only
    * layout that ever runs — and it runs per element, on elements that declare a
    * `layout`. A node with children and none renders them wherever their own
    * unset bounds land, which is outside the shape: name labels beside their
    * nodes, effect labels adrift on the canvas. No assertion about positions or
    * sizes can see that, so `layout` has to be asserted in its own right.
    */
   it('gives every flow node a layout, without which its children render outside it', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const nodes = [...(byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]), ...(byType(graph, PROCESS_GATEWAY_NODE_TYPE) as GNode[])];
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
         expect(node.layout).toBe('vbox');
      }
      // The effect compartment stacks its lines itself; its parent supplies the
      // padding. Reached through the owning task's children rather than `byType`,
      // which scans the graph's top level only — a compartment is nested, so
      // `byType` finds none and an assertion on it would pass vacuously.
      const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
      const compartment = pay.children.find(child => child.type === PROCESS_EFFECT_COMPARTMENT_TYPE) as GCompartment | undefined;
      expect(compartment?.layout).toBe('vbox');
   });

   /**
    * A size in the `.layout` file was put there by a resize, so content must not
    * push it around afterwards — and `size` alone does not achieve that. Every
    * node declares a `layout`, so the client lays it out and the layouter writes
    * the container's bounds from what it computes.
    *
    * The layouter that runs is GLSP's `VBoxLayouterExt`, which rebinds sprotty's
    * `vbox` kind. It resolves a container's fixed extent from the layout OPTIONS
    * and never from its bounds — `elementOptions?.prefWidth ?? 0` — so
    * `prefWidth` / `prefHeight` is the only channel a persisted size reaches
    * layout through, and it is honoured both as a floor on the content area and
    * as a floor on the container.
    *
    * Asserting the OPTION rather than the rendered size is the point: the size
    * survives on the GModel either way, and it is the option that decides
    * whether the client keeps it.
    */
   it('carries a persisted size into the layout as a preferred size', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
      expect(pay.size).toEqual({ width: 160, height: 60 });
      expect(pay.layoutOptions).toMatchObject({ prefWidth: 160, prefHeight: 60 });
   });

   /**
    * `resizeContainer: false` is the spelling that must NOT come back, however
    * well it expresses the intent. Under it `VBoxLayouterExt` computes
    * `max(0, 0 - paddingLeft - paddingRight)` for its content width, the
    * `maxWidth > 0` guard fails, and `layoutChildren` never runs — the node keeps
    * its size and every child renders at the node ORIGIN, name label and effect
    * lines drawn over each other. Nothing reports it: sprotty binds its `ILogger`
    * to `NullLogger`, so the diagnostics the layouter emits are discarded.
    */
   it('never opts a node out of container resizing', async () => {
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const nodes = [...(byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]), ...(byType(graph, PROCESS_GATEWAY_NODE_TYPE) as GNode[])];
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
         expect(node.layoutOptions?.resizeContainer).toBeUndefined();
      }
   });

   it('leaves a node with no persisted size on content-fit', async () => {
      // `Cancel` is deliberately absent from the sample workspace's layout file.
      // With no `prefWidth` / `prefHeight` the layouter fits it to its content,
      // which is what gives a hand-authored `.process` sensible bounds before
      // anyone has touched it — a preferred size would freeze every unsized node
      // at whatever it first measured.
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const cancel = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Cancel')!;
      expect(cancel.layoutOptions?.prefWidth).toBeUndefined();
      expect(cancel.layoutOptions?.prefHeight).toBeUndefined();
   });

   it('leaves a flow node with no diagram entry on its own size, not the positioned one', async () => {
      // `Cancel` is deliberately absent from the sample workspace's `.layout`
      // file, so it takes the fallback position and the notation's size floors
      // rather than anything persisted. The point is that neither is borrowed
      // from a node that HAS an entry — the two differ on both axes.
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const cancel = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Cancel')!;
      const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
      expect(cancel.position).not.toEqual(pay.position);
      expect(cancel.size).not.toEqual(pay.size);
   });

   it('contributes only the position when an entry has no size', async () => {
      // `size` is optional in the grammar, which is the state a node created
      // from the canvas is in before the client has ever measured it. Asserted
      // directly rather than left to the gateway entry that has this shape in
      // the sample workspace: that one is read through a different element type
      // and a different set of layout options, so it cannot stand in for the
      // task path.
      const harness = await makeWorkspaceHarness();
      const root = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;
      const layoutRoot = layoutRootFor(harness, 'orders/fulfillment.process');
      const entry = asMutable(layoutRoot.nodes.find(node => node.flowNode.$refText === 'Pay')!);
      const size = { width: entry.width, height: entry.height };
      entry.width = undefined;
      entry.height = undefined;
      try {
         const { graph } = runFactory(root, layoutRoot);

         const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
         const unpositioned = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Cancel')!;
         expect(pay.position).toEqual({ x: 40, y: 100 });
         // Size stayed at the builder default, i.e. the same as a node with no
         // entry at all — the position was applied without it.
         expect(pay.size).toEqual(unpositioned.size);
         // And no preferred size went with it, so the node stays content-fit.
         expect(pay.layoutOptions?.prefWidth).toBeUndefined();
      } finally {
         entry.width = size.width;
         entry.height = size.height;
      }
   });

   it('ignores a layout entry whose flow node does not resolve', async () => {
      // Stale layout is ordinary in a hand-editable file: delete a task in text
      // and its `node` line is left behind. The walk must not fail on it.
      const harness = await makeWorkspaceHarness();
      const root = documentFor<ProcessModel>(harness, 'orders/fulfillment.process').parseResult.value;
      const layoutRoot = layoutRootFor(harness, 'orders/fulfillment.process');
      const entry = asMutable(layoutRoot.nodes[0]);
      const original = entry.flowNode;
      // A properly typed unresolved reference, not a structural stand-in: the
      // compiler checks this really is a `Reference<FlowNode>` shape, which is
      // what catches an assignment the linker would reject at runtime.
      entry.flowNode = { $refText: 'Ghost', ref: undefined };
      try {
         const { graph } = runFactory(root, layoutRoot);

         // Every flow node is still emitted; only the stale entry's bounds are lost.
         expect((byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).map(node => node.id)).toEqual(['Pay', 'Pick', 'Ship', 'Cancel']);
         const pay = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Pay')!;
         const cancel = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Cancel')!;
         // `Pay`'s entry is now stale, so `Pay` and `Cancel` are BOTH
         // unpositioned — and they must not coincide. Two nodes at one point
         // means the wider one hides the other completely, and a diagram drawing
         // four shapes for a five-node model reads as the head having dropped an
         // element rather than as a node with nowhere to be.
         expect(pay.position).not.toEqual(cancel.position);
         // The stacking order is document order, so it is stable across
         // rebuilds: `Pay` is first in `root.nodes`, `Cancel` last.
         expect(pay.position).toEqual({ x: 0, y: 0 });
         expect(cancel.position).toEqual({ x: 0, y: 80 });
      } finally {
         entry.flowNode = original;
      }
   });

   it('keeps a SINGLE unpositioned node at the origin', async () => {
      // The sample workspace has exactly one — `Cancel` — and the browser tier's
      // append-on-drag test reads `Cancel 0,0` as the signature of a write that
      // arrived without a `newPosition`. Stacking must therefore start at the
      // origin rather than at the first row, or that test loses the one value it
      // can distinguish a half-completed write by.
      const harness = await makeWorkspaceHarness();
      const graph = await buildGraph(harness, 'orders/fulfillment.process');

      const cancel = (byType(graph, PROCESS_TASK_NODE_TYPE) as GNode[]).find(node => node.id === 'Cancel')!;
      expect(cancel.position).toEqual({ x: 0, y: 0 });
   });
});
