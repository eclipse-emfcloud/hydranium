/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ActionHandler, type Command, JsonOperationHandler, ModelState } from '@eclipse-glsp/server';
import { appendChild, buildAstNode } from '@hydranium/core';
import { type AstNode, type ReferenceInfo } from '@hydranium/langium';
import { defineMessage, type MessageDefinition, type Mutable } from '@hydranium/protocol';
import {
   EditProcessOperation,
   RequestProcessEditAction,
   SetProcessEditAction,
   type ProcessEditValues
} from '@hydranium/example-order-flow-protocol';
import { inject, injectable } from 'inversify';
import { Branch, type Effect, isRead, isWrite, isGateway, isEntity, isField, isFlowNode } from '../../language-server/ast.js';
import { processNode } from '../../language-server/order-flow-ast-builder.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import type { OrderFlowGlspState } from '../order-flow-glsp-state.js';

export const PROCESS_EDIT_STALE = defineMessage(
   'order-flow/process/edit-stale',
   'The process changed while this editor was open. Close it and try again.'
);
export const PROCESS_EDIT_UNAVAILABLE = defineMessage('order-flow/process/edit-unavailable', 'This element is no longer available.');
export const PROCESS_EDIT_REFERENCE_INVALID = defineMessage(
   'order-flow/process/edit-reference-invalid',
   'Choose a valid target for every reference.'
);
export const BRANCH_LABEL_INVALID = defineMessage(
   'order-flow/process/branch-label-invalid',
   'Enter a valid identifier for the branch label. Reserved words are not allowed.'
);
export const BRANCH_LABEL_DUPLICATE = defineMessage(
   'order-flow/process/branch-label-duplicate',
   'A branch with this label already exists.'
);

/** Queries use detached stand-ins so selecting a predecessor never edits the built document. */
export function processEdit(state: OrderFlowGlspState, elementId: string, values?: ProcessEditValues): SetProcessEditAction {
   const node = state.index.findSemanticElement(elementId);
   const result: SetProcessEditAction = {
      kind: SetProcessEditAction.KIND,
      responseId: '',
      sourceVersion: state.version,
      values: { ...values },
      candidates: {}
   };
   if (!node) {
      return result;
   }
   const built = state.builtNodeOf(node);
   const services = state.languageServicesFor(built);
   if (!built || !services) {
      return result;
   }
   const query = (container: AstNode, property: keyof ProcessEditValues): AstNode | undefined => {
      const info: ReferenceInfo = { container, property, reference: { ref: undefined, $refText: '' } };
      const candidates = services.references.CandidateProvider.find(info);
      result.candidates[property] = candidates;
      const value = result.values[property];
      if (!value || !candidates.some(candidate => candidate.value === value)) {
         return undefined;
      }
      const description = services.references.ScopeProvider.getScope(info).getElement(value);
      if (!description) {
         return undefined;
      }
      const document = services.shared.workspace.LangiumDocuments.getDocument(description.documentUri);
      return description.node ?? (document && services.workspace.AstNodeLocator.getAstNode(document.parseResult.value, description.path));
   };
   if (isGateway(built)) {
      result.mode = 'branch';
      const branch = buildAstNode<Branch>(services.shared.AstReflection, Branch.$type, {
         $container: built,
         $containerProperty: 'branches'
      });
      query(branch, 'target');
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
      const effect = buildAstNode<Effect>(services.shared.AstReflection, built.$type, {
         $container: built.$container,
         $containerProperty: 'effects'
      });
      const entity = query(effect, 'entity');
      if (isEntity(entity)) {
         (effect as Mutable<Effect>).entity = { ref: entity, $refText: result.values.entity! };
         const field = query(effect, 'field');
         if (isField(field)) {
            (effect as Mutable<Effect>).field = { ref: field, $refText: result.values.field! };
            if (isWrite(effect)) {
               query(effect, 'literal');
            }
         }
      }
   }
   return result;
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
      const parsed = state.languageServicesFor(state.sourceRoot)?.parser.LangiumParser.parse(`process P for E { gateway G ${label} -> T }`);
      if (!parsed || parsed.parserErrors.length || parsed.lexerErrors.length) {
         return BRANCH_LABEL_INVALID;
      }
      return valid('target') ? undefined : PROCESS_EDIT_REFERENCE_INVALID;
   }
   return valid('entity') && valid('field') && (!isWrite(node) || valid('literal')) ? undefined : PROCESS_EDIT_REFERENCE_INVALID;
}

@injectable()
export class OrderFlowRequestProcessEditHandler implements ActionHandler {
   readonly actionKinds = [RequestProcessEditAction.KIND];
   @inject(ModelState) protected readonly modelState!: OrderFlowGlspState;
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
         edit.validationError =
            this.modelState.languageServicesFor(this.modelState.sourceRoot)?.shared.MessageRenderer.renderMessage(error) ?? error.text;
      }
      return [{ ...edit, responseId: action.requestId }];
   }
}

/** Each edit validates the complete reference chain again before recording one undo step. */
@injectable()
export class OrderFlowEditProcessOperationHandler extends JsonOperationHandler {
   readonly operationType = EditProcessOperation.KIND;
   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: EditProcessOperation): Command | undefined {
      // Unnamed effects have positional ids; a newer root can assign the id to another effect.
      if (operation.sourceVersion !== this.modelState.version) {
         return undefined;
      }
      const node = this.modelState.index.findSemanticElement(operation.elementId);
      const edit = processEdit(this.modelState, operation.elementId, operation.values);
      if (processEditValidation(this.modelState, operation.elementId, operation.values, edit)) {
         return undefined;
      }
      if (isGateway(node)) {
         const label = operation.values.label!;
         const target = this.modelState.sourceRoot.nodes.find(candidate => candidate.name === operation.values.target);
         if (!isFlowNode(target)) {
            return undefined;
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
         return new OrderFlowCommand(this.modelState, 'Retarget effect', () => {
            const mutable = node as Mutable<Effect>;
            mutable.entity = { ref: undefined, $refText: operation.values.entity! };
            mutable.field = { ref: undefined, $refText: operation.values.field! };
            if (isWrite(mutable)) {
               (mutable as Mutable<typeof mutable>).literal = { ref: undefined, $refText: operation.values.literal! };
            }
         });
      }
      return undefined;
   }
}
