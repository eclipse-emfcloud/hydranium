/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   type ClientMenuItem,
   EditorContextService,
   type IActionDispatcher,
   type IActionHandler,
   type IContextMenuItemProvider,
   TYPES
} from '@eclipse-glsp/client';
import { resolve, type MessageDefinition, type ResolvedMessage } from '@hydranium/protocol';
import * as messages from './order-flow-process-edit-messages';
import { inject, injectable, preDestroy } from 'inversify';
import {
   EditProcessOperation,
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   RequestProcessEditAction,
   type SetProcessEditAction,
   type ProcessEditValues
} from '@hydranium/example-order-flow-protocol';

export interface OpenProcessEditAction extends Action {
   kind: typeof OPEN_PROCESS_EDIT;
   elementId: string;
}
export const OPEN_PROCESS_EDIT = 'orderFlowOpenProcessEdit';
export namespace OpenProcessEditAction {
   export function create(elementId: string): OpenProcessEditAction {
      return { kind: OPEN_PROCESS_EDIT, elementId };
   }
}

export const ProcessEditMessageRenderer = Symbol('ProcessEditMessageRenderer');
export type ProcessEditMessageRenderer = (message: ResolvedMessage) => string;

/** The shared contributor keeps grammar and reference resolution on the server. */
@injectable()
export class OrderFlowProcessEdit implements IContextMenuItemProvider, IActionHandler {
   @inject(EditorContextService) protected readonly editorContext!: EditorContextService;
   @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
   @inject(ProcessEditMessageRenderer) protected readonly renderMessage!: ProcessEditMessageRenderer;
   protected dialog?: HTMLDialogElement;

   @preDestroy()
   dispose(): void {
      this.dialog?.close();
   }

   async getItems(): Promise<ClientMenuItem[]> {
      const element = this.editableSelection();
      if (!element) {
         return [];
      }
      return [
         {
            id: OPEN_PROCESS_EDIT,
            label: this.text(element.type === PROCESS_EFFECT_TYPE ? messages.RETARGET_MENU : messages.BRANCH_MENU),
            group: 'edit',
            actions: [OpenProcessEditAction.create(element.id)],
            isEnabled: () => !this.editorContext.isReadonly
         }
      ];
   }

   editableSelection() {
      const selected = this.editorContext.selectedElements;
      return !this.editorContext.isReadonly &&
         selected.length === 1 &&
         (selected[0].type === PROCESS_EFFECT_TYPE || selected[0].type === PROCESS_GATEWAY_NODE_TYPE)
         ? selected[0]
         : undefined;
   }

   text(message: MessageDefinition<string>): string {
      return this.renderMessage(resolve(message));
   }

   handle(action: OpenProcessEditAction): void {
      if (this.editorContext.isReadonly || this.dialog) {
         return;
      }
      // Returning the request promise would hold the dispatch queue that delivers its answer.
      this.open(action.elementId);
   }

   protected open(elementId: string): void {
      const dialog = document.createElement('dialog');
      this.dialog = dialog;
      dialog.className = 'order-flow-process-edit';
      dialog.setAttribute('aria-label', this.text(messages.EDIT));
      const form = document.createElement('form');
      const title = document.createElement('h2');
      title.textContent = this.text(messages.EDIT);
      const fields = document.createElement('fieldset');
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const apply = document.createElement('button');
      apply.type = 'submit';
      apply.textContent = this.text(messages.APPLY);
      apply.disabled = true;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = this.text(messages.CANCEL);
      cancel.onclick = () => dialog.close();
      form.append(title, fields, status, apply, cancel);
      dialog.append(form);
      document.body.append(dialog);
      const modeListener = this.editorContext.onEditModeChanged(() => {
         if (this.editorContext.isReadonly) {
            dialog.close();
         }
      });
      dialog.addEventListener(
         'close',
         () => {
            modeListener.dispose();
            dialog.remove();
            this.dialog = undefined;
         },
         { once: true }
      );
      let values: ProcessEditValues | undefined;
      let generation = 0;
      let sourceVersion: number | undefined;
      const refresh = async (): Promise<void> => {
         const current = ++generation;
         apply.disabled = true;
         fields.disabled = true;
         status.textContent = this.text(messages.LOADING);
         try {
            const response = await this.dispatcher.request<SetProcessEditAction>({
               kind: RequestProcessEditAction.KIND,
               requestId: '',
               elementId,
               sourceVersion,
               values
            } as RequestProcessEditAction);
            if (!dialog.open || this.dialog !== dialog || current !== generation) {
               return;
            }
            if (response.validationError || !response.mode) {
               status.textContent = response.validationError ?? this.text(messages.UNAVAILABLE);
               return;
            }
            sourceVersion ??= response.sourceVersion;
            values = { ...response.values };
            title.textContent = response.mode === 'branch' ? this.text(messages.BRANCH) : this.text(messages.RETARGET);
            fields.replaceChildren();
            const keys: (keyof ProcessEditValues)[] =
               response.mode === 'branch'
                  ? ['label', 'target']
                  : response.mode === 'write'
                    ? ['entity', 'field', 'literal']
                    : ['entity', 'field'];
            for (const key of keys) {
               const label = document.createElement('label');
               label.textContent = this.text(messages.FIELD_LABELS[key]);
               const input = key === 'label' ? document.createElement('input') : document.createElement('select');
               input.name = key;
               input.required = true;
               if (input instanceof HTMLSelectElement) {
                  input.add(new Option(this.text(messages.CHOOSE), ''));
                  for (const candidate of response.candidates[key] ?? []) {
                     input.add(new Option(candidate.label, candidate.value));
                  }
               }
               input.value = values[key] ?? '';
               if (input instanceof HTMLSelectElement && input.selectedIndex < 0) {
                  input.value = '';
               }
               input.onchange = () => {
                  values = { ...values, [key]: input.value };
                  if (key === 'entity') {
                     values.field = undefined;
                     values.literal = undefined;
                  }
                  if (key === 'field') {
                     values.literal = undefined;
                  }
                  if (key === 'entity' || key === 'field') {
                     void refresh();
                  }
               };
               label.append(input);
               fields.append(label);
            }
            status.textContent = '';
            fields.disabled = false;
            apply.disabled = false;
         } catch {
            if (this.dialog === dialog && current === generation) {
               status.textContent = this.text(messages.LOAD_FAILED);
            }
         }
      };
      const submit = async (submitted: ProcessEditValues): Promise<void> => {
         const current = ++generation;
         fields.disabled = true;
         apply.disabled = true;
         status.textContent = this.text(messages.CHECKING);
         let stale = false;
         try {
            const response = await this.dispatcher.request<SetProcessEditAction>({
               kind: RequestProcessEditAction.KIND,
               requestId: '',
               elementId,
               values: submitted,
               sourceVersion,
               validate: true
            } as RequestProcessEditAction);
            if (!dialog.open || this.dialog !== dialog || current !== generation || this.editorContext.isReadonly) {
               return;
            }
            stale = response.sourceVersion !== sourceVersion;
            if (response.validationError || !response.mode) {
               status.textContent = response.validationError ?? this.text(messages.UNAVAILABLE);
               return;
            }
            await this.dispatcher.dispatch(EditProcessOperation.create(elementId, submitted, sourceVersion!));
            dialog.close();
         } catch {
            if (this.dialog === dialog && current === generation) {
               status.textContent = this.text(messages.CHECK_FAILED);
            }
         } finally {
            if (this.dialog === dialog && current === generation) {
               fields.disabled = stale;
               apply.disabled = stale;
            }
         }
      };
      form.onsubmit = event => {
         event.preventDefault();
         if (apply.disabled || this.editorContext.isReadonly || !form.reportValidity()) {
            return;
         }
         const submitted: ProcessEditValues = {};
         for (const [key, value] of new FormData(form)) {
            submitted[key as keyof ProcessEditValues] = String(value);
         }
         void submit(submitted);
      };
      dialog.showModal();
      void refresh();
   }
}
