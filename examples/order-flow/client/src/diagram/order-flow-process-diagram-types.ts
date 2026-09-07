/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultTypes } from '@eclipse-glsp/protocol';

/**
 * The client half of the `.process` diagram contract: the diagram type GLSP
 * routes by, the element type ids the server stamps onto the GModel, and the
 * file extension a host registers an editor for.
 *
 * **Every value here is duplicated by construction** — the server declares the
 * same contract in `order-flow/server/src/glsp/order-flow-process-diagram-types.ts`
 * and the two processes cannot import each other. Nothing detects the drift at
 * runtime: sprotty's model and view registries are exact-key maps with no
 * prefix fallback, so an unknown id becomes a featureless generic element
 * rendered by `MissingView` and the diagram type simply never matches. Both
 * failures are silent, which is why `test/process-diagram-contract.test.ts`
 * asserts every value against the server's own constants.
 *
 * Imports resolve `DefaultTypes` from `@eclipse-glsp/protocol` rather than
 * `@eclipse-glsp/client`: the client bundle's `require`s reach CSS files, so
 * keeping this module on the protocol package is what lets the contract test
 * run headless with no bundler in front of it.
 */

/** The GLSP diagram type this client renders. */
export const PROCESS_DIAGRAM_TYPE = 'order-flow-process';

/** Files a host should open in the `.process` diagram editor. */
export const PROCESS_DIAGRAM_FILE_EXTENSIONS = ['.process'] as const;

/** Human-readable diagram name, for editor tabs and command labels. */
export const PROCESS_DIAGRAM_LABEL = 'Order Flow Process Diagram';

/** A `Task` — a step that reads or writes domain state. */
export const PROCESS_TASK_NODE_TYPE = `${DefaultTypes.NODE}:task`;

/** A `Gateway` — a branch point, shaped differently from a task. */
export const PROCESS_GATEWAY_NODE_TYPE = `${DefaultTypes.NODE}:gateway`;

/** Compartment holding a task's `reads` / `writes` effect lines. */
export const PROCESS_EFFECT_COMPARTMENT_TYPE = `${DefaultTypes.COMPARTMENT}:effects`;

/** One `reads` / `writes` line inside the effect compartment. */
export const PROCESS_EFFECT_TYPE = `${DefaultTypes.LABEL}:effect`;

/** An explicit `transition a -> b`. */
export const PROCESS_TRANSITION_EDGE_TYPE = `${DefaultTypes.EDGE}:transition`;

/** A gateway `Branch` (`yes -> Pick`), which carries a label. */
export const PROCESS_BRANCH_EDGE_TYPE = `${DefaultTypes.EDGE}:branch`;

/**
 * Every element type id the server's GModel factory stamps.
 *
 * Declared as a tuple so {@link ProcessElementType} is a union of the ids
 * rather than `string`: the view table in
 * `order-flow-process-diagram-module.ts` is keyed by that union, so adding an
 * id here without registering a model class and a view for it does not
 * compile. That is the half of the contract a test cannot cover — a missing
 * registration is only visible in a browser console.
 */
export const PROCESS_ELEMENT_TYPES = [
   PROCESS_TASK_NODE_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_EFFECT_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE,
   PROCESS_BRANCH_EDGE_TYPE
] as const;

/** One of the element type ids in {@link PROCESS_ELEMENT_TYPES}. */
export type ProcessElementType = (typeof PROCESS_ELEMENT_TYPES)[number];
