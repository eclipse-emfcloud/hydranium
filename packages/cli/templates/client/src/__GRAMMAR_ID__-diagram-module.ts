// The client side of the __GRAMMAR__ diagram: how each element type the server
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
   __GRAMMAR_ID_CONST___EDGE_TYPE,
   __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE,
   __GRAMMAR_ID_CONST___NODE_TYPE,
   type __GRAMMAR__ElementType
} from '__PROTOCOL_PACKAGE__';

/** GLSP's edge view plus an arrowhead at the target, so an edge reads in the direction of its reference. */
@injectable()
export class __GRAMMAR__EdgeView extends GEdgeView {
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
   // Drawn like a node of the document; the server marks it with the `external` CSS class.
   [__GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE]: { model: GNode, view: RoundedCornerNodeView },
   // The framework's edge rather than `GEdge`: GLSP's gives the labels of an
   // edge without bendpoints no finite bounds, and fitting the diagram to its
   // pane then blanks the canvas.
   [__GRAMMAR_ID_CONST___EDGE_TYPE]: { model: HydraniumGEdge, view: __GRAMMAR__EdgeView }
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
