/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createDiagramOptionsModule, DefaultTypes, type GEdge, type SModelRegistry, TYPES } from '@eclipse-glsp/client';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import { initializeOrderFlowProcessDiagramContainer } from '../src/diagram/order-flow-process-diagram-module';
import { PROCESS_BRANCH_EDGE_TYPE, PROCESS_TRANSITION_EDGE_TYPE } from '../src/diagram/order-flow-process-diagram-types';

/**
 * Built through the container, as a host builds it, so what is asserted is the
 * class the model factory hands out for each type and not the table it reads.
 */
function buildEdge(type: string): GEdge {
   const container = initializeOrderFlowProcessDiagramContainer(
      new Container(),
      createDiagramOptionsModule({ clientId: 'one', diagramType: 'diagram-one', glspClientProvider: async () => ({}) as never })
   );
   const edge = container.get<SModelRegistry>(TYPES.SModelRegistry).get(type) as GEdge;
   edge.routingPoints = [];
   return edge;
}

describe('.process diagram module', () => {
   // A branch label sits on an edge with no bendpoints; GLSP's own edge
   // transforms it through `NaN` there, and fit-to-screen blanks the canvas.
   it.each([PROCESS_TRANSITION_EDGE_TYPE, PROCESS_BRANCH_EDGE_TYPE, DefaultTypes.EDGE])(
      'builds `%s` so a label on it keeps finite bounds without bendpoints',
      type => {
         expect(buildEdge(type).localToParent({ x: 1, y: 2 })).toEqual({ x: 1, y: 2, width: -1, height: -1 });
      }
   );
});
