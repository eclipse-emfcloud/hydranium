/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ActionHandler, type Command, JsonOperationHandler, ModelState } from '@eclipse-glsp/server';
import { appendChild, type ServerSharedServices } from '@hydranium/core';
import { type AstNode, type ReferenceInfo } from '@hydranium/langium';
import { defineMessage, type MessageDefinition, type Mutable } from '@hydranium/protocol';
import {
   PROCESS_EDIT_UNAVAILABLE,
   EditProcessOperation,
   RequestProcessEditAction,
   SetProcessEditAction,
   type ProcessEditValues
} from '@hydranium/example-order-flow-protocol';
import { DiagramEditRejectedError, HydraniumTypes } from '@hydranium/glsp-server';
import { inject, injectable } from 'inversify';
import {
   Branch,
   type Effect,
   type EnumLiteral,
   isRead,
   isWrite,
   isGateway,
   isEntity,
   isField,
   isFlowNode,
   isEnumLiteral
} from '../../language-server/ast.js';
import { processNode } from '../../language-server/order-flow-ast-builder.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import type { OrderFlowGlspState } from '../order-flow-glsp-state.js';

export const PROCESS_EDIT_STALE = defineMessage(
   'order-flow/process/edit-stale',
   'The process changed while this editor was open. Reopen the editor and try again.'
);
export { PROCESS_EDIT_UNAVAILABLE } from '@hydranium/example-order-flow-protocol';
export const PROCESS_EDIT_REFERENCE_INVALID = defineMessage(
   'order-flow/process/edit-reference-invalid',
   'Choose a valid target for every reference.'
);
export const BRANCH_LABEL_INVALID = defineMessage(
   'order-flow/process/branch-label-invalid',
   'Enter a valid identifier for the branch label.'
);
export const BRANCH_LABEL_DUPLICATE = defineMessage(
   'order-flow/process/branch-label-duplicate',
   'A branch with this label already exists.'
);

export function processEdit(state: OrderFlowGlspState, elementId: string, values?: ProcessEditValues): SetProcessEditAction {
   return queryProcessEdit(state, elementId, values).response;
}

export interface ProcessEditQuery {
   response: SetProcessEditAction;
   targets: Partial<Record<keyof ProcessEditValues, AstNode>>;
}

/** Queries use detached stand-ins so selecting a predecessor never edits the built document. */
function queryProcessEdit(state: OrderFlowGlspState, elementId: string, values?: ProcessEditValues): ProcessEditQuery {
   const node = state.index.findSemanticElement(elementId);
   const result: SetProcessEditAction = {
      kind: SetProcessEditAction.KIND,
      responseId: '',
      sourceVersion: state.version,
      values: { ...values },
      candidates: {}
   };
   const targets: ProcessEditQuery['targets'] = {};
   const queryResult = { response: result, targets };
   if (!node) {
      return queryResult;
   }
   const built = state.builtNodeOf(node);
   const services = state.languageServicesFor(built);
   if (!built || !services) {
      return queryResult;
   }
   const query = (info: ReferenceInfo, property: keyof ProcessEditValues): AstNode | undefined => {
      const candidates = state.candidateProviderFor(built)!.find(info);
      result.candidates[property] = candidates;
      const value = result.values[property];
      if (!value || !candidates.some(candidate => candidate.value === value)) {
         return undefined;
      }
      const target = services.references.Linker.buildReference(info.container, property, undefined, value).ref;
      targets[property] = target;
      return target;
   };
   if (isGateway(built)) {
      result.mode = 'branch';
      const info = state.referenceInfoAt(built, [{ type: Branch.$type, containerProperty: 'branches' }], 'target')!;
      query(info, 'target');
      // The diagram operation connects nodes in this process by their own names.
      const localNames = new Set(state.sourceRoot.nodes.map(node => node.name));
      result.candidates.target = result.candidates.target?.filter(candidate => localNames.has(candidate.value));
   } else if (isRead(built) || isWrite(built)) {
      result.mode = isWrite(built) ? 'write' : 'read';
      result.values = values ?? {
         entity: built.entity?.$refText,
         field: built.field?.$refText,
         literal: isWrite(built) ? built.literal?.$refText : undefined
      };
      const info = state.referenceInfoAt(built.$container!, [{ type: built.$type, containerProperty: 'effects' }], 'entity')!;
      const effect = info.container as Effect;
      const entity = query(info, 'entity');
      if (isEntity(entity)) {
         (effect as Mutable<Effect>).entity = { ref: entity, $refText: result.values.entity! };
         const field = query({ ...info, property: 'field' }, 'field');
         if (isField(field)) {
            (effect as Mutable<Effect>).field = { ref: field, $refText: result.values.field! };
            if (isWrite(effect)) {
               query({ ...info, property: 'literal' }, 'literal');
            }
         }
      }
   }
   return queryResult;
}

/** Preflight and operation validation share the same rules; the operation rechecks after any intervening edit. */
export function processEditValidation(
   state: OrderFlowGlspState,
   elementId: string,
   values: ProcessEditValues,
   edit: SetProcessEditAction
): MessageDefinition<string> | undefined {
   const node = state.index.findSemanticElement(elementId);
   if (!edit.mode || !node) {
      return PROCESS_EDIT_UNAVAILABLE;
   }
   const valid = (key: keyof ProcessEditValues): boolean => !!edit.candidates[key]?.some(candidate => candidate.value === values[key]);
   if (isGateway(node)) {
      const label = values.label;
      if (typeof label !== 'string' || !/^[_a-zA-Z][\w_]*$/.test(label)) {
         return BRANCH_LABEL_INVALID;
      }
      if (node.branches.some(branch => branch.label === label)) {
         return BRANCH_LABEL_DUPLICATE;
      }
      return valid('target') ? undefined : PROCESS_EDIT_REFERENCE_INVALID;
   }
   return valid('entity') && valid('field') && (!isWrite(node) || valid('literal')) ? undefined : PROCESS_EDIT_REFERENCE_INVALID;
}

@injectable()
export class OrderFlowRequestProcessEditHandler implements ActionHandler {
   readonly actionKinds = [RequestProcessEditAction.KIND];
   @inject(ModelState) protected readonly modelState!: OrderFlowGlspState;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
   execute(action: RequestProcessEditAction): SetProcessEditAction[] {
      const stale = (action.sourceVersion !== undefined || action.validate) && action.sourceVersion !== this.modelState.version;
      const edit: SetProcessEditAction = stale
         ? {
              kind: SetProcessEditAction.KIND,
              responseId: '',
              sourceVersion: this.modelState.version,
              values: { ...action.values },
              candidates: {}
           }
         : processEdit(this.modelState, action.elementId, action.values);
      const error = stale
         ? PROCESS_EDIT_STALE
         : action.validate && processEditValidation(this.modelState, action.elementId, action.values ?? {}, edit);
      if (error) {
         edit.validationError = this.sharedServices.MessageRenderer.renderMessage(error);
      }
      return [{ ...edit, responseId: action.requestId }];
   }
}

/** Each edit validates the complete reference chain again before recording one undo step. */
@injectable()
export class OrderFlowEditProcessOperationHandler extends JsonOperationHandler {
   readonly operationType = EditProcessOperation.KIND;
   declare protected modelState: OrderFlowGlspState;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   override createCommand(operation: EditProcessOperation): Command | undefined {
      // Unnamed effects have positional ids; a newer root can assign the id to another effect.
      if (operation.sourceVersion !== this.modelState.version) {
         this.rejectEdit(PROCESS_EDIT_STALE);
      }
      const node = this.modelState.index.findSemanticElement(operation.elementId);
      const { response: edit, targets } = queryProcessEdit(this.modelState, operation.elementId, operation.values);
      const validationError = processEditValidation(this.modelState, operation.elementId, operation.values, edit);
      if (validationError) {
         this.rejectEdit(validationError);
      }
      if (isGateway(node)) {
         const label = operation.values.label!;
         const target = this.modelState.sourceRoot.nodes.find(candidate => candidate.name === operation.values.target);
         if (!isFlowNode(target)) {
            this.rejectEdit(PROCESS_EDIT_REFERENCE_INVALID);
         }
         return new OrderFlowCommand(this.modelState, 'Create branch', () => {
            appendChild(
               node,
               'branches',
               node.branches,
               processNode(Branch, { label, target: this.modelState.referenceTo(target, node, { tier: 'own' })! })
            );
         });
      }
      if (isRead(node) || isWrite(node)) {
         if (
            node.entity?.$refText === operation.values.entity &&
            node.field?.$refText === operation.values.field &&
            (!isWrite(node) || node.literal?.$refText === operation.values.literal)
         ) {
            return undefined;
         }
         const { entity, field, literal } = targets;
         if (!isEntity(entity) || !isField(field) || (isWrite(node) && !isEnumLiteral(literal))) {
            this.rejectEdit(PROCESS_EDIT_REFERENCE_INVALID);
         }
         return new OrderFlowCommand(this.modelState, 'Retarget effect', () => {
            const mutable = node as Mutable<Effect>;
            mutable.entity = this.modelState.referenceTo(entity, node)!;
            mutable.field = this.modelState.referenceTo(field, node, { tier: 'own' })!;
            if (isWrite(mutable)) {
               (mutable as Mutable<typeof mutable>).literal = this.modelState.referenceTo(literal as EnumLiteral, node, { tier: 'own' })!;
            }
         });
      }
      return undefined;
   }

   /** A rejected submitted edit must reach the client even when preflight accepted an earlier model. */
   protected rejectEdit(message: MessageDefinition<string>): never {
      throw new DiagramEditRejectedError(this.sharedServices.MessageRenderer.renderMessage(message));
   }
}
