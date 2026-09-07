/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultTypes } from '@eclipse-glsp/server';

/**
 * The GLSP diagram-type and element-type ids for the `.process` diagram.
 *
 * **This module is the authoritative half of a client/server contract.** Every
 * id here has to be registered on the client too — sprotty's registries are
 * exact-key maps with no prefix fallback, so an id the client does not know
 * yields a generic `SChildElementImpl` (none of a node's features) rendered by
 * `MissingView`, with only a `no registered view for type '…'` warning in the
 * browser console. Nothing fails server-side, which is why the drift is
 * asserted in `examples/order-flow/client`'s test rather than left to review.
 * The ids are still namespaced under the GLSP defaults (`node:` / `edge:`) so
 * a reader can tell a node id from an edge id at a glance.
 *
 * `.process` is the GLSP-primary grammar of the three: a flow's topology is
 * invisible in text and obvious in a diagram, which is the asymmetry the
 * example exists to demonstrate. `.domain` deliberately has no diagram, and
 * `.layout` carries only the layout overlay.
 */

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type
 * request by, bound on `OrderFlowProcessDiagramModule.diagramType` and
 * mirrored by the client's `PROCESS_DIAGRAM_TYPE`. A mismatch silently drops
 * the request rather than reporting an unknown diagram type.
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
