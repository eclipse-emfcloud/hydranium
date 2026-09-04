/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Command, DeleteElementOperation, JsonOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import {
   type Branch,
   type DiagramNode,
   type Effect,
   type FlowNode,
   type Transition,
   isBranch,
   isEffect,
   isFlowNode,
   isGateway,
   isTask,
   isTransition
} from '../../language-server/ast.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';
import { removeChildren } from './containment.js';

/** What one delete operation resolved to, after the cascade was expanded. */
interface DeleteSet {
   readonly flowNodes: Set<FlowNode>;
   readonly transitions: Set<Transition>;
   readonly branches: Set<Branch>;
   readonly effects: Set<Effect>;
   /** `.layout` entries laying out a deleted flow node; not independently deletable. */
   readonly layout: Set<DiagramNode>;
}

/**
 * One handler for every deletable `.process` element: flow nodes, transitions,
 * gateway branches and individual effects.
 *
 * **The cascade is the substance of this handler.** Deleting a flow node must
 * also delete every `Transition` and every gateway `Branch` that references
 * it. Without that, the file keeps `transition Pick -> Ship` after `Ship` is
 * gone: the reference dangles, the diagram silently drops the edge (the GModel
 * factory skips unresolved endpoints), and the user sees a successful delete
 * that left the document invalid. Deleting a gateway additionally removes the
 * branches it contains, which containment already implies.
 *
 * Effects are deleted directly rather than cascaded — nothing references an
 * effect — and are the remove half of the add/remove effect surface.
 *
 * **`.layout` entries cascade too, and are not independently deletable.** A
 * `DiagramNode` is not an element of the diagram; it is where a flow node's
 * bounds live, so it has no delete affordance of its own but must go when its
 * flow node does — otherwise `node Ship at 660, 200` outlives `Ship` and dangles
 * exactly like an orphaned transition. That makes a delete a two-document write.
 *
 * **The cascade's completeness is the fragile part of this handler**, in the same
 * way the rename sweep is: it claims to cover every reference to a flow node
 * anywhere in the languages this server registers, so it goes stale the moment a
 * referring property is added — silently, because the delete still succeeds and
 * only the leftover reference fails to link.
 */
@injectable()
export class OrderFlowDeleteElementOperationHandler extends JsonOperationHandler {
   readonly operationType = DeleteElementOperation.KIND;

   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: DeleteElementOperation): MaybePromise<Command | undefined> {
      const toDelete = this.collect(operation);
      if (this.isEmpty(toDelete)) {
         return undefined;
      }
      return new OrderFlowCommand(this.modelState, 'Delete elements', () => this.deleteElements(toDelete));
   }

   /**
    * Expand the requested ids into everything that has to go with them.
    *
    * A branch whose owning gateway is also being deleted is left out of
    * `branches`: it disappears with its container, and splicing it out of a
    * list that is itself about to be dropped would renumber siblings for no
    * reason.
    */
   protected collect(operation: DeleteElementOperation): DeleteSet {
      const flowNodes = new Set<FlowNode>();
      const transitions = new Set<Transition>();
      const branches = new Set<Branch>();
      const effects = new Set<Effect>();
      const layout = new Set<DiagramNode>();

      for (const elementId of operation.elementIds) {
         const element = this.modelState.index.findSemanticElement(elementId, isDeletable);
         if (isFlowNode(element)) {
            flowNodes.add(element);
         } else if (isTransition(element)) {
            transitions.add(element);
         } else if (isBranch(element)) {
            branches.add(element);
         } else if (isEffect(element)) {
            effects.add(element);
         }
      }

      const root = this.modelState.sourceRoot;
      for (const transition of root.transitions) {
         if (this.touches(flowNodes, transition.source?.ref) || this.touches(flowNodes, transition.target?.ref)) {
            transitions.add(transition);
         }
      }
      for (const node of root.nodes) {
         if (!isGateway(node) || flowNodes.has(node)) {
            continue;
         }
         for (const branch of node.branches) {
            if (this.touches(flowNodes, branch.target?.ref)) {
               branches.add(branch);
            }
         }
      }
      // Layout entries live in the `.layout` secondary, so deleting a node is
      // inherently a two-document write: drop the semantics AND the entry that
      // positioned it, or the next load reports a dangling layout reference.
      for (const entry of this.modelState.layoutRoot.nodes) {
         if (this.touches(flowNodes, entry.flowNode?.ref)) {
            layout.add(entry);
         }
      }
      return { flowNodes, transitions, branches, effects, layout };
   }

   protected deleteElements(toDelete: DeleteSet): void {
      const root = this.modelState.sourceRoot;
      removeChildren(root.transitions, toDelete.transitions);
      for (const node of root.nodes) {
         if (isGateway(node)) {
            removeChildren(node.branches, toDelete.branches);
         }
         if (isTask(node)) {
            removeChildren(node.effects, toDelete.effects);
         }
      }
      removeChildren(this.modelState.layoutRoot.nodes, toDelete.layout);
      removeChildren(root.nodes, toDelete.flowNodes);
   }

   protected touches(flowNodes: ReadonlySet<FlowNode>, candidate: FlowNode | undefined): boolean {
      return candidate !== undefined && flowNodes.has(candidate);
   }

   /**
    * `layout` is deliberately not consulted: it is derived entirely from
    * `flowNodes`, so it can never be the only non-empty set, and checking it
    * would suggest a layout-only delete is a thing the client can ask for.
    */
   protected isEmpty(toDelete: DeleteSet): boolean {
      return (
         toDelete.flowNodes.size === 0 && toDelete.transitions.size === 0 && toDelete.branches.size === 0 && toDelete.effects.size === 0
      );
   }
}

/** Every `.process` element the diagram offers a delete affordance for. */
function isDeletable(item: unknown): item is FlowNode | Transition | Branch | Effect {
   return isFlowNode(item) || isTransition(item) || isBranch(item) || isEffect(item);
}
