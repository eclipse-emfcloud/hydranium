/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultTypes, GCompartment, GEdge, GGraph, GLabel, type GModelFactory, GNode, ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import {
   type DiagramNode,
   type Effect,
   type FlowNode,
   type Gateway,
   type ProcessModel,
   type Task,
   isGateway,
   isTask,
   isWrite
} from '../language-server/ast.js';
import {
   PROCESS_BRANCH_EDGE_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from './order-flow-process-diagram-types.js';
import { type OrderFlowGlspState } from './order-flow-glsp-state.js';

/**
 * Micro-layout for a flow node: stack the name label and the effect
 * compartment, with room around them.
 *
 * **Without a `layout` the children are not positioned at all.** The diagram
 * configuration sets `layoutKind: NONE` and `needsClientLayout: true`, so the
 * only layout that ever runs is sprotty's client-side micro-layout — and that
 * runs per element, on elements that declare one. A node with children and no
 * `layout` renders them wherever their own (unset) bounds put them, which is
 * outside the shape: name labels floating beside their nodes, effect labels
 * adrift on the canvas.
 *
 * `minWidth` / `minHeight` are floors so a one-word task is not a sliver. They
 * are also the mechanism a persisted size is applied through:
 * {@link OrderFlowProcessGModelFactory.applyBounds} raises them to the size the
 * `.layout` file records, so the two never contradict each other.
 */
export const NODE_LAYOUT_OPTIONS = {
   paddingLeft: 12,
   paddingRight: 12,
   paddingTop: 8,
   paddingBottom: 8,
   vGap: 4,
   hAlign: 'left',
   minWidth: 120,
   minHeight: 40
} as const;

/**
 * A gateway is a DIAMOND, so its label sits in the inscribed rectangle rather
 * than the bounding box — half the width and half the height are lost to the
 * corners. The generous padding buys that back; with the node defaults the
 * label overhangs the shape on both sides.
 *
 * **The vertical padding is where a gateway's HEIGHT comes from, and its
 * symmetry is what centres the label.** A `vbox` has no vertical alignment: it
 * stacks children from `paddingTop` and then computes the container's height as
 * content plus padding, so equal top and bottom padding puts an only child
 * exactly in the middle whatever the font measures. The failure mode is a
 * `.layout` entry pinning a height LARGER than that computed one — the label has
 * already been placed at `paddingTop` by then, so it ends up tucked under the
 * top vertex with empty diamond below it, and nothing reports it.
 *
 * The EXTENT is as load-bearing as the label's position, and it is why these
 * are not the task floors. At a task's 160x60 the diamond's top and bottom faces
 * are barely off horizontal: an edge that meets one exactly still reads as
 * stopping short of the shape, and a pointer crossing the bounding box is
 * outside the painted polygon for almost all of the sweep — which presents as
 * broken routing and dead hover rather than as a shape that is too flat.
 *
 * **A LABEL INSIDE the shape is what sets the floor, and it is the difference
 * from the notation this borrows from.** GLSP's own workflow example draws its
 * decision node at 32x32, which it can because the node carries no label at
 * all. Here the gateway's name is a child, so the shape has to be big enough for
 * the label to sit in the INSCRIBED rectangle — half the width and half the
 * height — and the padding is what buys that back. These are the smallest
 * figures that leave the name clear of both diagonals with margin, which is why
 * the height is well under the width rather than square: a gateway should read
 * as smaller than the tasks around it.
 */
export const GATEWAY_LAYOUT_OPTIONS = {
   paddingLeft: 32,
   paddingRight: 32,
   paddingTop: 34,
   paddingBottom: 34,
   hAlign: 'center',
   minWidth: 120,
   minHeight: 80
} as const;

/**
 * Effect lines stack tightly; the parent task already supplies the padding.
 *
 * **`minWidth` / `minHeight` are restated as zero because layout options are
 * INHERITED.** `AbstractLayout.getLayoutOptions` walks an element's whole
 * ancestor chain and merges what it finds, so anything left unset here takes the
 * task's value — and the task's floors exist to stop a one-word NODE collapsing,
 * which is not a statement about a compartment. Left inherited, a compartment
 * holding a single 12px effect line reserves the node's 40px minimum and the
 * node renders taller than the size its `.layout` entry asks for.
 */
const EFFECT_COMPARTMENT_LAYOUT_OPTIONS = {
   paddingLeft: 0,
   paddingRight: 0,
   paddingTop: 0,
   paddingBottom: 0,
   vGap: 2,
   hAlign: 'left',
   minWidth: 0,
   minHeight: 0
} as const;

/**
 * Row pitch for the nodes no `.layout` entry positions; see
 * {@link OrderFlowProcessGModelFactory.placeUnpositioned}.
 *
 * Clears the tallest shape the notation produces — a gateway, whose stated
 * floor is the largest of the three — so two stacked rows cannot touch. A
 * content-fit node can still grow past it, which is why the value has slack
 * rather than being the floor exactly.
 */
export const UNPOSITIONED_ROW_HEIGHT = 80;

/**
 * Translates a `.process` root into a GLSP {@link GGraph}. Nodes are emitted
 * before the connections that join them, so every edge endpoint id already
 * exists:
 *
 * - a {@link GNode} per flow node — task or gateway, distinct types;
 * - an effect {@link GCompartment} per task, one {@link GLabel} per
 *   `reads` / `writes` line;
 * - a {@link GEdge} per `transitions` entry;
 * - a {@link GEdge} per gateway `Branch`, labelled with the branch label.
 *
 * **Bounds come from the `.layout` file as an overlay rather than an
 * authority.** A flow node with a `DiagramNode` gets its persisted position,
 * and its size when a resize has set one; one without is left entirely to
 * client layout. That partiality is the design: layout is additive to a
 * hand-authored `.process` file, so any mix of positioned and unpositioned
 * nodes is a normal state rather than an error.
 *
 * **Unresolved references are tolerated, not assumed away.** Every `.ref` read
 * here can be `undefined` — a `.process` file referencing a task that does not
 * exist, or a `writes` clause naming a missing `.domain` field, is a state the
 * example deliberately produces (`test/fixtures/broken-effect.process`). An
 * edge whose endpoint cannot be resolved is skipped rather than emitted with a
 * dangling id, because a GLSP edge pointing at a non-existent node id fails
 * client-side with a far less obvious error than a missing edge.
 *
 * Ids come from the index (`OrderFlowGlspIndex`) rather than being composed
 * here. Transitions, branches and effects are unnamed, so the key provider's
 * fallback keys them by container position — which is exactly why the operation
 * handlers stamp that position on create (`appendChild`) and renumber it on
 * delete (`removeChildren`).
 *
 * The build also registers one **reference projection** — an effect label stands
 * for the `.domain` field it reads or writes ({@link registerEffectTarget}) —
 * which is what lets a diagnostic published on that other document surface as a
 * marker here.
 */
@injectable()
export class OrderFlowProcessGModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: OrderFlowGlspState;

   /**
    * Persisted bounds for the current walk, keyed by the flow node they lay
    * out. Rebuilt per {@link createModel} rather than cached, because the source
    * root is replaced on every rebuild.
    *
    * A `Map` keyed by the resolved `FlowNode` rather than by name: two
    * `DiagramNode`s naming the same flow node is a state the grammar permits,
    * and keying by identity makes the last one win deterministically instead of
    * depending on reference-text collation.
    */
   protected layout = new Map<FlowNode, DiagramNode>();

   /**
    * Where each flow node with NO `.layout` entry is drawn, keyed the same way
    * and rebuilt in the same walk.
    */
   protected fallbackPositions = new Map<FlowNode, { readonly x: number; readonly y: number }>();

   createModel(): void {
      const root = this.modelState.sourceRoot;
      const graph = GGraph.builder().id(this.modelState.sourceUri).build();
      if (root) {
         this.layout = this.collectLayout();
         this.fallbackPositions = this.placeUnpositioned(root);
         this.buildGraph(root, graph);
      }
      this.modelState.updateRoot(graph);
   }

   /**
    * Stack the nodes the `.layout` file does not position, one per row.
    *
    * **Without this every one of them is drawn at the graph origin, and any two
    * are therefore superimposed.** Nothing places an unpositioned node — the
    * diagram's `needsClientLayout` buys MICRO-layout, which sizes a node's label
    * and effect lines inside it, and there is no auto-layout module bound to
    * place the nodes themselves. So the second unpositioned node disappears
    * underneath the first, and the wider of the two hides the other completely.
    * Measured: renaming a task so its `.layout` entry no longer resolves puts it
    * at exactly `Cancel`'s coordinates, and the diagram then shows four shapes
    * for a five-node model — which reads as the head having dropped an element,
    * and sends a reader looking for a defect in the wrong place entirely.
    *
    * **The first one still lands at the origin**, so a fixture with a single
    * unpositioned node is unchanged. That is deliberate rather than incidental:
    * `Cancel` is the workspace's only such node, and the append-on-drag test
    * reads `0,0` as the signature of a half-completed write.
    *
    * A COLUMN rather than a diagonal cascade, and rows rather than a packing:
    * these nodes have no authored place, so the honest rendering is a list off to
    * one side, not an arrangement that implies someone chose it. One pass over
    * the nodes in document order, so the result is stable across rebuilds and
    * costs nothing on top of the walk that follows.
    */
   protected placeUnpositioned(root: ProcessModel): Map<FlowNode, { readonly x: number; readonly y: number }> {
      const positions = new Map<FlowNode, { readonly x: number; readonly y: number }>();
      let row = 0;
      for (const node of root.nodes) {
         if (this.layout.get(node) === undefined) {
            positions.set(node, { x: 0, y: row * UNPOSITIONED_ROW_HEIGHT });
            row++;
         }
      }
      return positions;
   }

   /**
    * Index the layout file's entries by resolved flow node, skipping entries
    * whose reference does not resolve — a layout entry naming a deleted task is
    * ordinary staleness in a hand-editable file, not a reason to fail the walk.
    *
    * Reads the SECONDARY document rather than the source root. A process with no
    * `.layout` beside it yields an empty map and every node falls to client
    * layout, which is the normal state for a flow authored entirely in text.
    */
   protected collectLayout(): Map<FlowNode, DiagramNode> {
      const layout = new Map<FlowNode, DiagramNode>();
      for (const node of this.modelState.layoutRoot?.nodes ?? []) {
         const flowNode = node.flowNode?.ref;
         if (flowNode) {
            layout.set(flowNode, node);
         }
      }
      return layout;
   }

   /**
    * Apply persisted bounds, if any, as an **overlay** on client layout.
    *
    * Deliberately partial in both directions: a flow node with no `layout`
    * entry falls back to {@link placeUnpositioned}, and an entry with a position
    * but no `size` contributes only the position. That is why the diagram
    * configuration keeps `needsClientLayout` — the client still measures, and
    * these values only override what has actually been persisted.
    *
    * **`needsClientLayout` does NOT place a node**, and reading it as though it
    * did is how the fallback came to be missing: it drives the MICRO-layout that
    * sizes a node's label and effect lines within it. Nothing in this diagram's
    * modules positions a node the `.layout` file has not, which is why the
    * fallback is computed here rather than left to the client.
    *
    * **A persisted size is carried as `prefWidth` / `prefHeight`**, which is
    * GLSP's own vocabulary for it. `size` alone does not survive: every node
    * here declares a `layout`, so the client lays it out, and the layouter
    * writes the container's bounds from what it computes.
    *
    * The layouter to read is GLSP's `VBoxLayouterExt`, NOT sprotty's
    * `VBoxLayouter` — GLSP rebinds the `vbox` kind, so sprotty's is dead code
    * here and reasoning from it gives the wrong answer. The extension resolves
    * a container's fixed extent from the layout OPTIONS and never from its
    * bounds:
    *
    * ```js
    * const width = elementOptions?.prefWidth ?? 0;   // not bounds.width
    * ```
    *
    * so `prefWidth` is the only channel a size reaches the layout through. It is
    * then honoured twice over — as a floor on the content area
    * (`max(prefWidth - padding, childrenSize)`) and as a floor on the container
    * (`max(prefWidth, computed)`) — which is exactly the intent, with the
    * padding accounted for by the layouter rather than by arithmetic here.
    *
    * **`resizeContainer: false` is not an option here.** With it, the same helper
    * yields `max(0, 0 - paddingLeft - paddingRight)`, the `maxWidth > 0` guard
    * fails, and `layoutChildren` never runs: the node keeps its size and every
    * child renders at the node ORIGIN, name label and effect lines drawn over
    * each other. Nothing reports it — sprotty's `ILogger` is bound to
    * `NullLogger`, so the two diagnostics the layouter emits are discarded.
    *
    * `prefWidth` is a floor rather than a fixed size, deliberately: a node whose
    * content does not fit grows past the persisted size instead of clipping its
    * own text. It cannot ratchet, because the value is re-read from the
    * `.layout` FILE on every walk rather than from the last rendered size, and
    * `OrderFlowChangeBoundsOperationHandler.isResize` keeps a plain move from
    * writing a size back at all.
    *
    * A node with no persisted size is left content-fit, which is what gives a
    * hand-authored `.process` sensible bounds before anyone has touched it. It
    * still gets a stated `size` — the notation's floors — and that is not the
    * same thing as pinning it: `prefWidth` is what the layouter honours, so a
    * size with no preferred size beside it is overwritten by the computed bounds
    * and the node stays content-fit.
    *
    * **The floors are stated because the builder's default is `-1`, and a
    * negative extent escapes into the DOM.** GLSP wraps `DiamondNodeView` and
    * `CircularNodeView` in a hidden bounding rect — a `<rect>` carrying the
    * node's own dimensions, so the measuring pass reports the stated bounds
    * instead of the painted shape's bbox — and it emits whatever it is given.
    * With `-1` the browser rejects the attribute and logs `<rect> attribute
    * width: A negative value is not valid` twice per shape, on a path where
    * nothing else is wrong: the visible render is correct, because the layouter
    * has replaced the bounds by then. It is reachable from the palette as well
    * as from a `.layout` entry with no `size`, since a created node is written
    * with a position alone.
    */
   protected applyBounds(
      builder: ReturnType<typeof GNode.builder>,
      node: FlowNode,
      floors: { readonly minWidth: number; readonly minHeight: number }
   ): void {
      const bounds = this.layout.get(node);
      const placement = bounds ?? this.fallbackPositions.get(node);
      if (placement) {
         builder.position(placement.x, placement.y);
      }
      if (bounds?.width !== undefined && bounds.height !== undefined) {
         builder.size(bounds.width, bounds.height);
         builder.addLayoutOptions({ prefWidth: bounds.width, prefHeight: bounds.height });
         return;
      }
      builder.size(floors.minWidth, floors.minHeight);
   }

   /** Emit nodes first, then the connections, so every edge endpoint id exists. */
   protected buildGraph(root: ProcessModel, graph: GGraph): void {
      for (const node of root.nodes) {
         graph.children.push(this.createFlowNode(node));
      }
      for (const transition of root.transitions) {
         const source = transition.source?.ref;
         const target = transition.target?.ref;
         if (!source || !target) {
            continue;
         }
         graph.children.push(
            GEdge.builder()
               .id(this.modelState.index.createId(transition))
               .type(PROCESS_TRANSITION_EDGE_TYPE)
               .sourceId(this.modelState.index.createId(source))
               .targetId(this.modelState.index.createId(target))
               .build()
         );
      }
      // Branches are emitted from their owning gateway rather than from a
      // top-level list, because the grammar nests them — the label belongs to
      // the branch, so the edge carries it as a child.
      for (const node of root.nodes) {
         if (!isGateway(node)) {
            continue;
         }
         for (const branch of node.branches) {
            const target = branch.target?.ref;
            if (!target) {
               continue;
            }
            graph.children.push(
               GEdge.builder()
                  .id(this.modelState.index.createId(branch))
                  .type(PROCESS_BRANCH_EDGE_TYPE)
                  .sourceId(this.modelState.index.createId(node))
                  .targetId(this.modelState.index.createId(target))
                  .add(
                     GLabel.builder()
                        .id(`${this.modelState.index.createId(branch)}_label`)
                        .text(branch.label)
                        .build()
                  )
                  .build()
            );
         }
      }
   }

   protected createFlowNode(node: FlowNode): GNode {
      if (isTask(node)) {
         return this.createTaskNode(node);
      }
      return this.createGatewayNode(node as Gateway);
   }

   protected createTaskNode(task: Task): GNode {
      const id = this.modelState.index.createId(task);
      const builder = GNode.builder()
         .id(id)
         .type(PROCESS_TASK_NODE_TYPE)
         .layout('vbox')
         .addLayoutOptions({ ...NODE_LAYOUT_OPTIONS })
         .add(GLabel.builder().id(`${id}_name`).text(task.name).type(DefaultTypes.LABEL).build());
      this.applyBounds(builder, task, NODE_LAYOUT_OPTIONS);
      if (task.effects.length > 0) {
         const compartment = GCompartment.builder()
            .id(`${id}_effects`)
            .type(PROCESS_EFFECT_COMPARTMENT_TYPE)
            .layout('vbox')
            .addLayoutOptions({ ...EFFECT_COMPARTMENT_LAYOUT_OPTIONS });
         for (const effect of task.effects) {
            // Keyed through the index rather than by position in this walk, so
            // the delete handler can resolve the label back to its Effect node.
            // A `${id}_effect_${i}` id would render identically and be
            // unresolvable.
            const effectId = this.modelState.index.createId(effect);
            this.registerEffectTarget(effect, effectId);
            compartment.add(GLabel.builder().id(effectId).type(PROCESS_EFFECT_TYPE).text(this.effectText(effect)).build());
         }
         builder.add(compartment.build());
      }
      return builder.build();
   }

   /**
    * Record that the effect label `labelId` also stands for the `.domain` field
    * the effect reads or writes — the index's reference-projection half
    * (`registerElementId`), which is the reverse of the containment keying every
    * other id here comes from.
    *
    * This is what makes a diagnostic published on ANOTHER document reachable
    * from this diagram. An effect's field lives in a `.domain` file, so an error
    * on it (a field whose type no longer resolves, say) is published on that
    * document and never on the `.process` one; without this registration the
    * index would not even report the `.domain` file as contributing a rendered
    * element, and `HydraniumGlspModelValidator` would not scan it.
    *
    * Deliberately the FIELD only, not the containing entity. Registering
    * `effect.entity` too would make every diagnostic anywhere in `Order` — an
    * unrelated field, a bad enum literal — light up every effect label on the
    * diagram, which is noise rather than feedback. The marker mapping already
    * walks up the `$container` chain, so an error on the field's own type
    * reference still lands here; an error on a field this diagram does not
    * touch correctly falls away.
    *
    * Unresolved references are skipped: `reads Order.nosuch` has no field to
    * project, and the diagnostic for that failure is published on the
    * `.process` document, where the effect's own id already carries it.
    */
   protected registerEffectTarget(effect: Effect, labelId: string): void {
      const field = effect.field?.ref;
      if (field) {
         this.modelState.index.registerElementId(field, labelId);
      }
   }

   protected createGatewayNode(gateway: Gateway): GNode {
      const id = this.modelState.index.createId(gateway);
      const builder = GNode.builder()
         .id(id)
         .type(PROCESS_GATEWAY_NODE_TYPE)
         .layout('vbox')
         .addLayoutOptions({ ...GATEWAY_LAYOUT_OPTIONS })
         .add(GLabel.builder().id(`${id}_name`).text(gateway.name).type(DefaultTypes.LABEL).build());
      this.applyBounds(builder, gateway, GATEWAY_LAYOUT_OPTIONS);
      return builder.build();
   }

   /**
    * Render an effect as the text the grammar accepts, reading reference TEXT
    * rather than resolved targets so a broken effect shows what the author
    * typed instead of collapsing to blanks — the same reasoning the `.process`
    * serializer applies.
    */
   protected effectText(effect: Effect): string {
      const entity = effect.entity?.$refText ?? '';
      const field = effect.field?.$refText ?? '';
      if (isWrite(effect)) {
         return `writes ${entity}.${field} = ${effect.literal?.$refText ?? ''}`;
      }
      return `reads ${entity}.${field}`;
   }
}
