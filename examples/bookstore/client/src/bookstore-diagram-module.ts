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
   configureModelElement,
   type ContainerConfiguration,
   GEdgeView,
   GNode,
   initializeDiagramContainer,
   RoundedCornerNodeView
} from '@eclipse-glsp/client';
import { configureHydraniumModelElements, HydraniumGEdge } from '@hydranium/glsp-client';
import { type Container, ContainerModule } from 'inversify';
import { BOOKSTORE_EDGE_TYPE, BOOKSTORE_NODE_TYPE, type BookstoreElementType } from '@hydranium/bookstore-protocol';

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
   // The framework's edge rather than `GEdge`: GLSP's gives the labels of an
   // edge without bendpoints no finite bounds, and fitting the diagram to its
   // pane then blanks the canvas.
   [BOOKSTORE_EDGE_TYPE]: { model: HydraniumGEdge, view: GEdgeView }
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
