/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Command, type CreateNodeOperation, JsonCreateNodeOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { type Entity, type Field, Read, type Task, isEntity, isTask } from '../../language-server/ast.js';
import { astNode } from '../../language-server/order-flow-ast-builder.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';
import { PROCESS_EFFECT_TYPE } from '../order-flow-process-diagram-types.js';
import { appendChild } from './containment.js';

/**
 * Adds a `reads <subject>.<field>` effect to a task.
 *
 * **Add and remove, no in-place edit.** Changing an existing effect's target is
 * left to text editing on purpose. An effect is three chained references
 * (`entity` → `field` → `literal`), each scoped by the previous, and the only
 * ways to edit it from the canvas are to accept free text and re-parse it —
 * putting a second parser for the `.process` syntax in the adopter — or to add
 * a structured operation and a client contributor to fill it, which is client
 * work this example does not have. Add/remove exercises the write path and the
 * scope chain without either.
 *
 * **A `reads`, not a `writes`.** `Write` needs a third reference to an
 * `EnumLiteral` of the enumeration the field's type resolves to, and most
 * fields are not enum-typed, so a created `writes` would frequently be
 * unresolvable on arrival. `reads` needs only an entity and a field, both of
 * which the process subject supplies.
 *
 * The field is the subject entity's first — an arbitrary but resolvable
 * starting point the user then edits in text. If the subject has no fields the
 * operation is rejected rather than creating a dangling effect: a blank
 * reference would serialize to `reads .` and fail to re-parse.
 */
@injectable()
export class OrderFlowCreateEffectOperationHandler extends JsonCreateNodeOperationHandler {
   override readonly label = 'Effect';
   elementTypeIds = [PROCESS_EFFECT_TYPE];

   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
      const task = this.resolveTask(operation);
      const entity = this.subjectEntity();
      const field = entity?.fields[0];
      if (!task || !entity || !field) {
         return undefined;
      }
      return new OrderFlowCommand(this.modelState, 'Create effect', () => this.createEffect(task, entity, field));
   }

   protected createEffect(task: Task, entity: Entity, field: Field): void {
      const root = this.modelState.sourceRoot;
      const references = this.modelState.languageServicesFor(root)?.references.ReferenceBuilder;
      const entityRef = references?.toOwnReference(entity);
      const fieldRef = references?.toOwnReference(field);
      if (!entityRef || !fieldRef) {
         this.modelState.logger.warn('Add effect skipped: the subject entity or its first field has no resolvable name');
         return;
      }
      appendChild(task, 'effects', task.effects, astNode(Read, { entity: entityRef, field: fieldRef }));
   }

   /**
    * The task the effect is added to. The client sends either the task node or
    * its effect compartment as the container, so a compartment id is walked up
    * to its owning task.
    */
   protected resolveTask(operation: CreateNodeOperation): Task | undefined {
      const containerId = operation.containerId;
      if (!containerId) {
         return undefined;
      }
      const direct = this.modelState.index.findSemanticElement(containerId, isTask);
      if (direct) {
         return direct;
      }
      const compartmentSuffix = '_effects';
      if (containerId.endsWith(compartmentSuffix)) {
         const ownerId = containerId.slice(0, -compartmentSuffix.length);
         return this.modelState.index.findSemanticElement(ownerId, isTask);
      }
      return undefined;
   }

   /**
    * The `Entity` the process is declared `for`. Read through the resolved
    * reference rather than its text, because an effect must point at a real
    * declaration — if the subject itself is unresolved there is nothing to
    * build a reference to.
    */
   protected subjectEntity(): Entity | undefined {
      const subject = this.modelState.sourceRoot.subject?.ref;
      return isEntity(subject) ? subject : undefined;
   }
}
