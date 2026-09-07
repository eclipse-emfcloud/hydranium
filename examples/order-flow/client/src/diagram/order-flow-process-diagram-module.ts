/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type ContainerConfiguration,
   DiamondNodeView,
   GCompartment,
   GEdge,
   GLabel,
   GLabelView,
   GNode,
   RoundedCornerNodeView,
   StructureCompartmentView,
   configureDefaultModelElements,
   configureModelElement,
   initializeDiagramContainer
} from '@eclipse-glsp/client';
import { type Container, ContainerModule } from 'inversify';
import {
   PROCESS_BRANCH_EDGE_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE,
   type ProcessElementType
} from './order-flow-process-diagram-types';
import { ProcessGatewayNode } from './order-flow-process-model';
import { ProcessEdgeView } from './order-flow-process-views';

/**
 * The model class and the view a `.process` element type renders through.
 *
 * Both slots are spelled as the parameter types of `configureModelElement`
 * itself, so the table cannot drift from the function it feeds.
 */
export interface ProcessElementRegistration {
   readonly model: Parameters<typeof configureModelElement>[2];
   readonly view: Parameters<typeof configureModelElement>[3];
}

/**
 * How each element type the server stamps is realised on the client.
 *
 * Keyed by {@link ProcessElementType}, so a new server element type added to
 * `PROCESS_ELEMENT_TYPES` fails to compile until it is realised here. That
 * closes the half of the client/server contract a test cannot: an id that
 * matches but has no registration still renders nothing, because sprotty falls
 * back to a featureless generic element plus `MissingView`.
 *
 * GLSP's defaults cover the rest of the tree — the task and gateway name
 * labels and the branch label are plain `DefaultTypes.LABEL`, and the graph
 * root is `DefaultTypes.GRAPH`, all registered by
 * `configureDefaultModelElements`.
 */
export const PROCESS_ELEMENT_REGISTRATIONS: Readonly<Record<ProcessElementType, ProcessElementRegistration>> = {
   [PROCESS_TASK_NODE_TYPE]: { model: GNode, view: RoundedCornerNodeView },
   // A gateway is a branch point, so it gets the shape the notation expects
   // rather than a second rounded rectangle — and the MODEL class that goes with
   // that shape, because the anchor an edge aims at comes from the model and not
   // from the view. See `ProcessGatewayNode`.
   [PROCESS_GATEWAY_NODE_TYPE]: { model: ProcessGatewayNode, view: DiamondNodeView },
   [PROCESS_EFFECT_COMPARTMENT_TYPE]: { model: GCompartment, view: StructureCompartmentView },
   [PROCESS_EFFECT_TYPE]: { model: GLabel, view: GLabelView },
   // Both connection types are directed, so both are drawn with an arrowhead;
   // what tells them apart is the stylesheet, keyed on the `transition` /
   // `branch` subtype class.
   [PROCESS_TRANSITION_EDGE_TYPE]: { model: GEdge, view: ProcessEdgeView },
   [PROCESS_BRANCH_EDGE_TYPE]: { model: GEdge, view: ProcessEdgeView }
};

/**
 * The `.process` diagram definition: GLSP's default model elements plus one
 * model/view registration per element type the server stamps.
 *
 * **Host-agnostic on purpose.** It binds nothing a host owns — no logger, no
 * connector, no message service — so the same module is loaded by the Theia
 * shell (through `@hydranium/glsp-client-theia`), by the VS Code shell (on
 * GLSP's `vscode-integration`) and by a browser app. Each host contributes its
 * own `ContainerModule` alongside this one; see
 * {@link initializeOrderFlowProcessDiagramContainer}.
 *
 * The tool palette needs no entries here: GLSP drives it from the server's
 * `shapeTypeHints` / `edgeTypeHints`, which is why the palette and the
 * operation handlers backing it live in `order-flow-server`.
 */
export const orderFlowProcessDiagramModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   const context = { bind, unbind, isBound, rebind };
   configureDefaultModelElements(context);
   for (const [elementTypeId, registration] of Object.entries(PROCESS_ELEMENT_REGISTRATIONS)) {
      configureModelElement(context, elementTypeId, registration.model, registration.view);
   }
});

/**
 * Build a `.process` diagram container. The host's own modules go through
 * `containerConfiguration`; the diagram definition is appended LAST.
 *
 * **A host cannot replace a model class or view by contributing the same
 * element type id, in either order.** sprotty's model and view registries are
 * exact-key maps whose `register` THROWS — `Key is already registered: <id>.
 * Use \`overrideModelElement\` instead.` (`sprotty/lib/utils/registry.js`) — so
 * ordering never picks a winner. A host that needs to swap one calls sprotty's
 * `overrideModelElement` — or `configureView` with `isOverride` for the view
 * alone — from a module applied to the container AFTER this function returns,
 * since the diagram definition is appended last and would otherwise be the one
 * throwing.
 */
export function initializeOrderFlowProcessDiagramContainer(
   container: Container,
   ...containerConfiguration: ContainerConfiguration
): Container {
   return initializeDiagramContainer(container, ...containerConfiguration, orderFlowProcessDiagramModule);
}
