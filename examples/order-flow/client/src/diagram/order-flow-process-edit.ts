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

/** The shared contributor keeps grammar and reference resolution on the server. */
@injectable()
export class OrderFlowProcessEdit implements IContextMenuItemProvider, IActionHandler {
   @inject(EditorContextService) protected readonly editorContext!: EditorContextService;
   @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
   protected dialog?: HTMLDialogElement;

   @preDestroy()
   dispose(): void {
      this.dialog?.close();
   }

   async getItems(): Promise<ClientMenuItem[]> {
      if (this.editorContext.isReadonly || this.editorContext.selectedElements.length !== 1) {
         return [];
      }
      const element = this.editorContext.selectedElements[0];
      if (element.type !== PROCESS_EFFECT_TYPE && element.type !== PROCESS_GATEWAY_NODE_TYPE) {
         return [];
      }
      return [
         {
            id: OPEN_PROCESS_EDIT,
            label: element.type === PROCESS_EFFECT_TYPE ? 'Retarget effect…' : 'Add branch…',
            group: 'edit',
            actions: [{ kind: OPEN_PROCESS_EDIT, elementId: element.id } as OpenProcessEditAction],
            isEnabled: () => !this.editorContext.isReadonly
         }
      ];
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
      dialog.setAttribute('aria-label', 'Edit process');
      const form = document.createElement('form');
      const title = document.createElement('h2');
      title.textContent = 'Edit process';
      const fields = document.createElement('fieldset');
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const apply = document.createElement('button');
      apply.type = 'submit';
      apply.textContent = 'Apply';
      apply.disabled = true;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
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
         status.textContent = 'Loading choices…';
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
               status.textContent = response.validationError ?? 'This element is no longer available.';
               return;
            }
            sourceVersion ??= response.sourceVersion;
            values = { ...response.values };
            title.textContent = response.mode === 'branch' ? 'Add branch' : 'Retarget effect';
            fields.replaceChildren();
            const keys: (keyof ProcessEditValues)[] =
               response.mode === 'branch'
                  ? ['label', 'target']
                  : response.mode === 'write'
                    ? ['entity', 'field', 'literal']
                    : ['entity', 'field'];
            for (const key of keys) {
               const label = document.createElement('label');
               label.textContent = key.charAt(0).toUpperCase() + key.slice(1);
               const input = key === 'label' ? document.createElement('input') : document.createElement('select');
               input.name = key;
               input.required = true;
               if (input instanceof HTMLSelectElement) {
                  input.add(new Option('Choose…', ''));
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
               status.textContent = 'Could not load choices. Close and try again.';
            }
         }
      };
      const submit = async (submitted: ProcessEditValues): Promise<void> => {
         const current = ++generation;
         fields.disabled = true;
         apply.disabled = true;
         status.textContent = 'Checking edit…';
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
               status.textContent = response.validationError ?? 'This element is no longer available.';
               return;
            }
            await this.dispatcher.dispatch(EditProcessOperation.create(elementId, submitted, sourceVersion!));
            dialog.close();
         } catch {
            if (this.dialog === dialog && current === generation) {
               status.textContent = 'Could not check the edit. Please try again.';
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
