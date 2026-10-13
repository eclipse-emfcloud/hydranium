/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import {
   createDiagramOptionsModule,
   DefaultTypes,
   GEdge,
   GEdgeView,
   GNode,
   initializeDiagramContainer,
   type SModelRegistry,
   TYPES,
   type ViewRegistry
} from '@eclipse-glsp/client';
import { Container, ContainerModule } from 'inversify';
import { describe, expect, it } from 'vitest';
import { configureHydraniumModelElements, HydraniumGEdge } from '../src/edge';

function makeEdge(routingPoints: { x: number; y: number }[]): HydraniumGEdge {
   const edge = new HydraniumGEdge();
   edge.routingPoints = routingPoints;
   return edge;
}

describe('HydraniumGEdge', () => {
   it('transforms a child through the origin when the route is empty', () => {
      const edge = makeEdge([]);
      expect(edge.localToParent({ x: 3, y: 4 })).toEqual({ x: 3, y: 4, width: -1, height: -1 });
      expect(edge.parentToLocal({ x: 3, y: 4, width: 5, height: 6 })).toEqual({ x: 3, y: 4, width: 5, height: 6 });
   });

   it("keeps GLSP's route offset when the route has points", () => {
      const edge = makeEdge([
         { x: 10, y: 20 },
         { x: 30, y: 40 }
      ]);
      const plain = new GEdge();
      plain.routingPoints = edge.routingPoints;
      expect(edge.localToParent({ x: 1, y: 2 })).toEqual(plain.localToParent({ x: 1, y: 2 }));
      expect(edge.parentToLocal({ x: 1, y: 2 })).toEqual(plain.parentToLocal({ x: 1, y: 2 }));
   });
});

describe('configureHydraniumModelElements', () => {
   const container = initializeDiagramContainer(
      new Container(),
      createDiagramOptionsModule({ clientId: 'one', diagramType: 'diagram-one', glspClientProvider: async () => ({}) as never }),
      new ContainerModule((bind, _unbind, isBound) => {
         configureHydraniumModelElements({ bind, isBound });
      })
   );
   const models = container.get<SModelRegistry>(TYPES.SModelRegistry);

   it("builds GLSP's default edge type as the framework edge, with GEdge's features", () => {
      const edge = models.get(DefaultTypes.EDGE);
      expect(edge).toBeInstanceOf(HydraniumGEdge);
      for (const feature of GEdge.DEFAULT_FEATURES) {
         expect(edge.hasFeature(feature)).toBe(true);
      }
   });

   it("keeps GLSP's edge view and its other defaults", () => {
      expect(container.get<ViewRegistry>(TYPES.ViewRegistry).get(DefaultTypes.EDGE)).toBeInstanceOf(GEdgeView);
      expect(models.get(DefaultTypes.NODE)).toBeInstanceOf(GNode);
   });
});
