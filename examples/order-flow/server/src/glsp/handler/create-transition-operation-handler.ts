/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Command, type CreateEdgeOperation, JsonCreateEdgeOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { type FlowNode, Transition, isFlowNode } from '../../language-server/ast.js';
import { astNode } from '../../language-server/order-flow-ast-builder.js';
import { canAddTransition } from '../../language-server/process-transition-rules.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';
import { PROCESS_TRANSITION_EDGE_TYPE } from '../order-flow-process-diagram-types.js';
import { appendChild } from './containment.js';

/**
 * Creates a `transition <source> -> <target>` between two flow nodes.
 *
 * Both endpoints are resolved from the GLSP element ids through the index and
 * checked with `isFlowNode`. That check is not ceremony: the client sends ids,
 * and the diagram also contains effect labels and compartments, so an id that
 * resolves to something which is not a flow node is reachable from a
 * mis-targeted drag. Returning `undefined` from `createCommand` rejects the
 * operation cleanly instead of building a `Transition` whose reference cannot
 * be serialized.
 *
 * Gateway branches are deliberately **not** creatable here. A `Branch` is
 * nested in its gateway and carries a label that is part of its syntax
 * (`yes -> Restock`), so creating one from a plain edge tool would have to
 * invent that label; it stays a text-editing affordance.
 */
@injectable()
export class OrderFlowCreateTransitionOperationHandler extends JsonCreateEdgeOperationHandler {
   override readonly label = 'Transition';
   elementTypeIds = [PROCESS_TRANSITION_EDGE_TYPE];

   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: CreateEdgeOperation): MaybePromise<Command | undefined> {
      const source = this.resolveFlowNode(operation.sourceElementId);
      const target = this.resolveFlowNode(operation.targetElementId);
      if (!source || !target) {
         return undefined;
      }
      // The same rules `OrderFlowEdgeCreationChecker` reports to the cursor,
      // asked again on the wire. The checker is FEEDBACK — it is only consulted
      // for a `dynamic` hint, and only by a client that chooses to ask — so
      // leaving the write unguarded would make the rule a UI convention rather
      // than a property of the model. No command means no submission and no
      // dirty state, which is the right answer for an operation that must not
      // land.
      if (!canAddTransition(this.modelState.sourceRoot, source, target)) {
         this.modelState.logger.info('Create transition rejected: it would duplicate an existing one or return to its own source');
         return undefined;
      }
      return new OrderFlowCommand(this.modelState, 'Create transition', () => this.createTransition(source, target));
   }

   protected createTransition(source: FlowNode, target: FlowNode): void {
      const root = this.modelState.sourceRoot;
      const references = this.modelState.languageServicesFor(root)?.references.ReferenceBuilder;
      const sourceRef = references?.toOwnReference(source);
      const targetRef = references?.toOwnReference(target);
      if (!sourceRef || !targetRef) {
         // `toOwnReference` returns undefined only for an unnamed target, which
         // a flow node cannot be — but building a Transition with a blank
         // `$refText` would serialize to `transition  -> ` and corrupt the file,
         // so this stays a hard stop rather than a fallback.
         this.modelState.logger.warn('Create transition skipped: an endpoint has no resolvable name');
         return;
      }
      appendChild(root, 'transitions', root.transitions, astNode(Transition, { source: sourceRef, target: targetRef }));
   }

   protected resolveFlowNode(elementId: string): FlowNode | undefined {
      return this.modelState.index.findSemanticElement(elementId, isFlowNode);
   }
}
