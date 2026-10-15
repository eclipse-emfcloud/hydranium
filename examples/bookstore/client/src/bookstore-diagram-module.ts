/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The client side of the Bookstore diagram: how each element type the server
// stamps is drawn. It binds nothing a host owns, so every host mounts this one
// module and adds its own beside it.

import {
   angleOfPoint,
   configureModelElement,
   type ContainerConfiguration,
   type GEdge,
   GEdgeView,
   GNode,
   initializeDiagramContainer,
   Point,
   type RenderingContext,
   RoundedCornerNodeView,
   svg,
   toDegrees
} from '@eclipse-glsp/client';
import { configureHydraniumModelElements, HydraniumGEdge } from '@hydranium/glsp-client';
import { type Container, ContainerModule, injectable } from 'inversify';
import {
   BOOKSTORE_EDGE_TYPE,
   BOOKSTORE_EXTERNAL_NODE_TYPE,
   BOOKSTORE_NODE_TYPE,
   type BookstoreElementType
} from '@hydranium/bookstore-protocol';

/** GLSP's edge view plus an arrowhead at the target, so an edge reads in the direction of its reference. */
@injectable()
export class BookstoreEdgeView extends GEdgeView {
   protected override renderAdditionals(edge: GEdge, segments: Point[], context: RenderingContext) {
      const end = segments[segments.length - 1];
      const degrees = toDegrees(angleOfPoint(Point.subtract(segments[segments.length - 2], end)));
      const arrow = svg('path', {
         'class-sprotty-edge-arrow': true,
         d: 'M 0,0 L 10,-4 L 10,4 Z',
         transform: `rotate(${degrees} ${end.x} ${end.y}) translate(${end.x} ${end.y})`
      });
      return [...super.renderAdditionals(edge, segments, context), arrow];
   }
}

/** The model class and view one element type renders through, as `configureModelElement` takes them. */
export interface BookstoreElementRegistration {
   readonly model: Parameters<typeof configureModelElement>[2];
   readonly view: Parameters<typeof configureModelElement>[3];
}

/**
 * One registration per element type the server stamps.
 *
 * Keyed by the protocol's union of ids, so an id added there does not compile
 * until it is drawn here: sprotty renders a type with no registration as
 * nothing, with only a console warning.
 */
export const BOOKSTORE_ELEMENT_REGISTRATIONS: Readonly<Record<BookstoreElementType, BookstoreElementRegistration>> = {
   [BOOKSTORE_NODE_TYPE]: { model: GNode, view: RoundedCornerNodeView },
   // Drawn like a node of the document; the server marks it with the `external` CSS class.
   [BOOKSTORE_EXTERNAL_NODE_TYPE]: { model: GNode, view: RoundedCornerNodeView },
   // The framework's edge rather than `GEdge`: GLSP's gives the labels of an
   // edge without bendpoints no finite bounds, and fitting the diagram to its
   // pane then blanks the canvas.
   [BOOKSTORE_EDGE_TYPE]: { model: HydraniumGEdge, view: BookstoreEdgeView }
};

/** GLSP's default model elements, plus the registrations above. */
export const bookstoreDiagramModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   const context = { bind, unbind, isBound, rebind };
   configureHydraniumModelElements(context);
   for (const [elementTypeId, registration] of Object.entries(BOOKSTORE_ELEMENT_REGISTRATIONS)) {
      configureModelElement(context, elementTypeId, registration.model, registration.view);
   }
});

/**
 * Build a Bookstore diagram container: the host's modules first and this
 * diagram's definition last, since GLSP gives an element type to whichever
 * module registered it last.
 */
export function initializeBookstoreDiagramContainer(container: Container, ...modules: ContainerConfiguration) {
   return initializeDiagramContainer(container, ...modules, bookstoreDiagramModule);
}
