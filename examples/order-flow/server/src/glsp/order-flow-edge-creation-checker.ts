/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type EdgeCreationChecker, type GModelElement, ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { isFlowNode } from '../language-server/ast.js';
import { canAddTransition } from '../language-server/process-transition-rules.js';
import { type OrderFlowGlspState } from './order-flow-glsp-state.js';
import { PROCESS_TRANSITION_EDGE_TYPE } from './order-flow-process-diagram-types.js';

/**
 * Live feedback while an edge is being drawn: which elements may start one, and
 * which may finish it.
 *
 * **Only consulted for a hint marked `dynamic`.** GLSP answers the static half
 * from `EdgeTypeHint.sourceElementTypeIds` / `targetElementTypeIds` without
 * asking anyone, and that is enough to rule out an effect label or a
 * compartment. What it cannot express is a rule about the MODEL rather than the
 * element type — that a transition may not return to its own source, and that
 * the pair must not already exist — because both depend on the other endpoint
 * and on what the document already says. So the transition hint sets
 * `dynamic: true` and the client asks per hover.
 *
 * The rules themselves are not here: {@link canAddTransition} is shared with the
 * create-transition operation handler and the `.process` validator, so the
 * cursor, the wire and the text cannot come to different conclusions.
 *
 * **A `false` here is feedback, not enforcement.** It moves the refusal to the
 * cursor, before the drop, which is the whole point — but a client that never
 * asks still reaches the operation handler, so the handler repeats the check.
 */
@injectable()
export class OrderFlowEdgeCreationChecker implements EdgeCreationChecker {
   @inject(ModelState) protected readonly modelState!: OrderFlowGlspState;

   isValidSource(edgeType: string, sourceElement: GModelElement): boolean {
      return edgeType === PROCESS_TRANSITION_EDGE_TYPE && this.flowNode(sourceElement) !== undefined;
   }

   isValidTarget(edgeType: string, sourceElement: GModelElement, targetElement: GModelElement): boolean {
      if (edgeType !== PROCESS_TRANSITION_EDGE_TYPE) {
         return false;
      }
      const root = this.modelState.sourceRoot;
      const source = this.flowNode(sourceElement);
      const target = this.flowNode(targetElement);
      if (!root || !source || !target) {
         return false;
      }
      return canAddTransition(root, source, target);
   }

   /**
    * The flow node a rendered element stands for, or `undefined` when it stands
    * for none — a compartment, an effect label, the graph itself. Resolved
    * through the index rather than by comparing the element's type, so an id
    * scheme change cannot silently turn this into a type check that passes for
    * something unresolvable.
    */
   protected flowNode(element: GModelElement) {
      return this.modelState.index.findSemanticElement(element.id, isFlowNode);
   }
}
