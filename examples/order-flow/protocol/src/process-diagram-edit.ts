/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Operation, RequestAction, ResponseAction } from '@eclipse-glsp/protocol';
import { defineMessage, type ReferenceCandidate } from '@hydranium/protocol';

export const PROCESS_EDIT_UNAVAILABLE = defineMessage('order-flow/process/edit-unavailable', 'This element is no longer available.');

export interface ProcessEditValues {
   entity?: string;
   field?: string;
   literal?: string;
   label?: string;
   target?: string;
}

export interface RequestProcessEditAction extends RequestAction<SetProcessEditAction> {
   kind: typeof RequestProcessEditAction.KIND;
   elementId: string;
   values?: ProcessEditValues;
   validate?: boolean;
   sourceVersion?: number;
}
export namespace RequestProcessEditAction {
   export const KIND = 'orderFlowRequestProcessEdit';
}

export interface SetProcessEditAction extends ResponseAction {
   kind: typeof SetProcessEditAction.KIND;
   mode?: 'read' | 'write' | 'branch';
   validationError?: string;
   sourceVersion: number;
   values: ProcessEditValues;
   candidates: Partial<Record<keyof ProcessEditValues, ReferenceCandidate[]>>;
}
export namespace SetProcessEditAction {
   export const KIND = 'orderFlowSetProcessEdit';
}

export interface EditProcessOperation extends Operation {
   kind: typeof EditProcessOperation.KIND;
   elementId: string;
   sourceVersion: number;
   values: ProcessEditValues;
}
export namespace EditProcessOperation {
   export const KIND = 'orderFlowEditProcess';
   export function create(elementId: string, values: ProcessEditValues, sourceVersion: number): EditProcessOperation {
      return { kind: KIND, isOperation: true, elementId, values, sourceVersion };
   }
}
