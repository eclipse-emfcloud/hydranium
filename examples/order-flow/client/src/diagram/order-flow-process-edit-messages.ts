/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineMessage } from '@hydranium/protocol';

export const EDIT = defineMessage('order-flow/process/edit', 'Edit process');
export const APPLY = defineMessage('order-flow/process/apply', 'Apply');
export const CANCEL = defineMessage('order-flow/process/cancel', 'Cancel');
export const LOADING = defineMessage('order-flow/process/loading', 'Loading choices…');
export { PROCESS_EDIT_UNAVAILABLE as UNAVAILABLE } from '@hydranium/example-order-flow-protocol';
export const BRANCH = defineMessage('order-flow/process/branch', 'Add branch');
export const RETARGET = defineMessage('order-flow/process/retarget', 'Retarget effect');
export const CHOOSE = defineMessage('order-flow/process/choose', 'Choose…');
export const LOAD_FAILED = defineMessage('order-flow/process/load-failed', 'Could not load choices. Close and try again.');
export const CHECKING = defineMessage('order-flow/process/checking', 'Checking edit…');
export const CHECK_FAILED = defineMessage('order-flow/process/check-failed', 'Could not check the edit. Please try again.');
export const RETARGET_MENU = defineMessage('order-flow/process/retarget-menu', 'Retarget effect…');
export const BRANCH_MENU = defineMessage('order-flow/process/branch-menu', 'Add branch…');
export const PALETTE = defineMessage('order-flow/process/palette', 'Edit selected effect or gateway');
export const ENTITY = defineMessage('order-flow/process/entity', 'Entity');
export const FIELD = defineMessage('order-flow/process/field', 'Field');
export const LITERAL = defineMessage('order-flow/process/literal', 'Literal');
export const LABEL = defineMessage('order-flow/process/label', 'Label');
export const TARGET = defineMessage('order-flow/process/target', 'Target');

export const FIELD_LABELS = { entity: ENTITY, field: FIELD, literal: LITERAL, label: LABEL, target: TARGET };
