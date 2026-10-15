// The client side of the __GRAMMAR__ diagram: how each element type the server
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
import { __GRAMMAR_ID_CONST___EDGE_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE, type __GRAMMAR__ElementType } from '__PROTOCOL_PACKAGE__';

/** The model class and view one element type renders through, as `configureModelElement` takes them. */
export interface __GRAMMAR__ElementRegistration {
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
export const __GRAMMAR_ID_CONST___ELEMENT_REGISTRATIONS: Readonly<Record<__GRAMMAR__ElementType, __GRAMMAR__ElementRegistration>> = {
   [__GRAMMAR_ID_CONST___NODE_TYPE]: { model: GNode, view: RoundedCornerNodeView },
   // The framework's edge rather than `GEdge`: GLSP's gives the labels of an
   // edge without bendpoints no finite bounds, and fitting the diagram to its
   // pane then blanks the canvas.
   [__GRAMMAR_ID_CONST___EDGE_TYPE]: { model: HydraniumGEdge, view: GEdgeView }
};

/** GLSP's default model elements, plus the registrations above. */
export const __GRAMMAR_CAMEL__DiagramModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   const context = { bind, unbind, isBound, rebind };
   configureHydraniumModelElements(context);
   for (const [elementTypeId, registration] of Object.entries(__GRAMMAR_ID_CONST___ELEMENT_REGISTRATIONS)) {
      configureModelElement(context, elementTypeId, registration.model, registration.view);
   }
});

/**
 * Build a __GRAMMAR__ diagram container: the host's modules first and this
 * diagram's definition last, since GLSP gives an element type to whichever
 * module registered it last.
 */
export function initialize__GRAMMAR__DiagramContainer(container: Container, ...modules: ContainerConfiguration) {
   return initializeDiagramContainer(container, ...modules, __GRAMMAR_CAMEL__DiagramModule);
}
