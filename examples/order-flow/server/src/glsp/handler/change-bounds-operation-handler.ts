/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   ChangeBoundsOperation,
   type Command,
   type ElementAndBounds,
   GNode,
   JsonOperationHandler,
   type MaybePromise
} from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { DiagramNode, type FlowNode, type LayoutModel, isFlowNode } from '../../language-server/ast.js';
import { astNode } from '../../language-server/order-flow-ast-builder.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';
import { appendChild } from './containment.js';

/** One resolved move/resize: the flow node the client addressed, and its new bounds. */
interface ResolvedBounds {
   readonly flowNode: FlowNode;
   readonly bounds: ElementAndBounds;
}

/**
 * Persists a move or resize as a `DiagramNode` entry in the `.layout` secondary.
 *
 * **This is NOT the framework's computed-bounds handler**, and the two are easy
 * to confuse: that one applies the client's *measured* bounds to the server-side
 * GModel transiently, and GLSP's own base documents them as not persisted.
 * Measurement and persistence are separate mechanisms, and only this one writes
 * to the source model.
 *
 * `ElementAndBounds` carries a required `newSize` and an **optional**
 * `newPosition`, so a pure resize arrives with no position at all. A
 * `DiagramNode` needs one (the grammar makes `at` mandatory), so a resize of a
 * never-positioned node falls back to the position the client is currently
 * rendering it at — which is what the user sees, and therefore the only
 * non-surprising value to persist.
 *
 * Ids that do not resolve to a flow node are dropped rather than rejected
 * wholesale. A `ChangeBoundsOperation` is a batch — dragging a selection sends
 * one entry per element — and the diagram also contains effect labels and
 * compartments, which are laid out by their parent task and have no independent
 * bounds to persist. Failing the whole batch because one entry was a label
 * would make multi-select drag unusable.
 */
@injectable()
export class OrderFlowChangeBoundsOperationHandler extends JsonOperationHandler {
   readonly operationType = ChangeBoundsOperation.KIND;
   override readonly label = 'Change bounds';

   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: ChangeBoundsOperation): MaybePromise<Command | undefined> {
      const resolved = this.resolveBounds(operation.newBounds);
      if (resolved.length === 0) {
         // No command means no submission and no dirty state — the correct
         // answer when every entry addressed something with no persistable
         // bounds, rather than recording an empty edit.
         return undefined;
      }
      return new OrderFlowCommand(this.modelState, this.label, () => this.persistBounds(resolved));
   }

   protected resolveBounds(newBounds: ElementAndBounds[]): ResolvedBounds[] {
      const resolved: ResolvedBounds[] = [];
      for (const bounds of newBounds) {
         const flowNode = this.modelState.index.findSemanticElement(bounds.elementId, isFlowNode);
         if (flowNode) {
            resolved.push({ flowNode, bounds });
         }
      }
      return resolved;
   }

   protected persistBounds(resolved: ResolvedBounds[]): void {
      // The SECONDARY document. `layoutRoot` is never undefined — it materialises
      // an empty in-memory root for a process with no `.layout` yet, so a first
      // drag produces a real diff instead of silently patching nothing.
      const layout = this.modelState.layoutRoot;
      for (const { flowNode, bounds } of resolved) {
         const entry = this.entryFor(layout, flowNode);
         if (!entry) {
            continue;
         }
         const position = bounds.newPosition ?? this.renderedPosition(bounds.elementId);
         if (position) {
            entry.x = position.x;
            entry.y = position.y;
         }
         // Only on an actual RESIZE. `ElementAndBounds.newSize` is REQUIRED by the
         // protocol (`newPosition` is the optional one), so a plain move arrives
         // carrying whatever size the client is currently rendering. Writing that
         // back unconditionally would persist a client-measured number as though
         // the author had chosen it, and put a `size` on every node the user so
         // much as dragged.
         //
         // It would also let the node ratchet. Sprotty's hidden-bounds pass
         // measures with `getBBox()`, which returns the union of the shape and any
         // child drawn outside it — so as soon as a node renders a child beyond
         // its own outline, each drag would persist a box larger than the node,
         // which renders larger and measures larger again, with no upper bound,
         // driven by a gesture that changes no size at all.
         if (this.isResize(bounds)) {
            entry.width = bounds.newSize.width;
            entry.height = bounds.newSize.height;
         }
      }
   }

   /**
    * Whether `bounds` changes the size, as opposed to only moving the element.
    *
    * Compares against the size the server-side GModel currently holds, which is
    * what the client is rendering — the framework's computed-bounds handler has
    * already applied the client's measurement to it. A node the client has not
    * measured yet has no size to compare, and is treated as a resize so a first
    * genuine resize is not swallowed.
    */
   protected isResize(bounds: ElementAndBounds): boolean {
      const node = this.modelState.index.find(bounds.elementId);
      if (!(node instanceof GNode) || node.size === undefined) {
         return true;
      }
      return node.size.width !== bounds.newSize.width || node.size.height !== bounds.newSize.height;
   }

   /**
    * The layout entry for `flowNode`, appended if this is its first move.
    *
    * Returns `undefined` only when the flow node has no resolvable name, which
    * the grammar makes impossible — but a blank reference would serialize to
    * `node  at 0, 0` and corrupt the file, so it stays a hard stop rather than
    * a fallback, matching the create handlers.
    *
    * The reference is built against the FLOW NODE's own language services, not
    * the layout's: the entry lives in a `.layout` document but names a node
    * owned by a `.process` one, and the two grammars are free to differ in how
    * they qualify names. Routing through `languageServicesFor(flowNode)` is what
    * keeps the diagram's naming rules from being applied to a foreign node.
    */
   protected entryFor(layout: LayoutModel, flowNode: FlowNode): DiagramNode | undefined {
      const existing = layout.nodes.find(node => node.flowNode?.ref === flowNode);
      if (existing) {
         return existing;
      }
      const reference = this.modelState.languageServicesFor(flowNode)?.references.ReferenceBuilder.toOwnReference(flowNode);
      if (!reference) {
         this.modelState.logger.warn('Change bounds skipped: the moved element has no resolvable name');
         return undefined;
      }
      // `x` / `y` are mandatory in the grammar, so the builder requires them
      // here; the caller overwrites them from the operation immediately.
      return appendChild(layout, 'nodes', layout.nodes, astNode(DiagramNode, { flowNode: reference, x: 0, y: 0 }));
   }

   /**
    * Where the client is currently drawing the element, used only when a resize
    * arrives for a node that has never been positioned.
    */
   protected renderedPosition(elementId: string): { x: number; y: number } | undefined {
      const node = this.modelState.index.find(elementId);
      return node instanceof GNode ? node.position : undefined;
   }
}
