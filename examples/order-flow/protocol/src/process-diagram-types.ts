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
 * The GLSP diagram-type and element-type ids for the `.process` diagram, which
 * the server stamps onto the GModel and every client registers.
 *
 * Declared once, here, for both ends. A drift between them fails silently:
 * sprotty's registries are exact-key maps with no prefix fallback, so an id the
 * client does not know yields a generic `SChildElementImpl` rendered by
 * `MissingView`, with only a `no registered view for type '…'` warning in the
 * browser console. The ids are namespaced under the GLSP defaults (`node:` /
 * `edge:`) so a reader can tell a node id from an edge id at a glance.
 *
 * `.process` is the GLSP-primary grammar of the three: a flow's topology is
 * invisible in text and obvious in a diagram, which is the asymmetry the
 * example exists to demonstrate. `.domain` deliberately has no diagram, and
 * `.layout` carries only the layout overlay.
 */

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type
 * request by, bound on `OrderFlowProcessDiagramModule.diagramType`. A mismatch
 * silently drops the request rather than reporting an unknown diagram type.
 */
export const PROCESS_DIAGRAM_TYPE = 'order-flow-process';

/** A `Task` — a step that reads or writes domain state. */
export const PROCESS_TASK_NODE_TYPE = `${DefaultTypes.NODE}:task`;

/** A `Gateway` — a branch point. Distinct type so the client can shape it differently. */
export const PROCESS_GATEWAY_NODE_TYPE = `${DefaultTypes.NODE}:gateway`;

/** Compartment holding a task's `reads` / `writes` effect lines. */
export const PROCESS_EFFECT_COMPARTMENT_TYPE = `${DefaultTypes.COMPARTMENT}:effects`;

/**
 * One `reads` / `writes` line inside the effect compartment.
 *
 * A distinct type rather than a plain label because an effect is separately
 * creatable and deletable: the delete handler needs to tell an effect label
 * from the task's own name label, and both render as labels.
 */
export const PROCESS_EFFECT_TYPE = `${DefaultTypes.LABEL}:effect`;

/** An explicit `transition a -> b`. */
export const PROCESS_TRANSITION_EDGE_TYPE = `${DefaultTypes.EDGE}:transition`;

/**
 * A gateway `Branch` (`yes -> Pick`). A separate edge type from a transition
 * because it carries a label and originates from a gateway rather than from
 * the flow sequence — the two are different concepts that happen to render
 * as connections.
 */
export const PROCESS_BRANCH_EDGE_TYPE = `${DefaultTypes.EDGE}:branch`;

/**
 * Every element type id the server's GModel factory stamps.
 *
 * Declared as a tuple so {@link ProcessElementType} is a union of the ids
 * rather than `string`: the client's registration table is keyed by that
 * union, so an id in the tuple without a model class and a view does not
 * compile. Nothing in the compiler holds the tuple to the constants above; a
 * client test does.
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
