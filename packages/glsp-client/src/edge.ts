/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type BindingContext,
   type Bounds,
   configureDefaultModelElements,
   DefaultTypes,
   GEdge,
   GEdgeView,
   isBounds,
   overrideModelElement,
   type Point
} from '@eclipse-glsp/client';

/**
 * GLSP's edge, with an empty route transforming its children through the
 * origin.
 *
 * `GEdge` offsets a child by the bounds of its routing points, and sprotty's
 * `getRouteBounds` answers `NaN` for an empty route, which an edge without
 * bendpoints always has. An edge label's bounds then come out `NaN`, and a
 * fit-to-screen over every element lands the viewport at `translate(NaN,NaN)`,
 * where every shape fails its visibility check and the canvas goes blank.
 *
 * Register your own edge types with this class in place of `GEdge`; sprotty
 * fixes a type's class when it is registered, so an edge type registered with
 * `GEdge` keeps the defect. Patching `GEdge`'s prototype would reach those
 * types too, and is not done: it is no extension point of GLSP's.
 */
export class HydraniumGEdge extends GEdge {
   override localToParent(point: Point | Bounds): Bounds {
      return this.routingPoints.length === 0 ? asBounds(point) : super.localToParent(point);
   }

   override parentToLocal(point: Point | Bounds): Bounds {
      return this.routingPoints.length === 0 ? asBounds(point) : super.parentToLocal(point);
   }
}

/** The shape `GEdge` returns: a point gains the size `-1`, bounds keep theirs. */
function asBounds(point: Point | Bounds): Bounds {
   return { x: point.x, y: point.y, width: isBounds(point) ? point.width : -1, height: isBounds(point) ? point.height : -1 };
}

/**
 * GLSP's default model elements, with `DefaultTypes.EDGE` built as a
 * {@link HydraniumGEdge}.
 *
 * Call it from your diagram module in place of GLSP's
 * `configureDefaultModelElements`. The replacement cannot come from the
 * binder: a diagram module is loaded after the host's, and GLSP's model
 * registry gives a type to whichever registration came last, so a replacement
 * bound before the defaults is the one overwritten.
 */
export function configureHydraniumModelElements(context: Pick<BindingContext, 'bind' | 'isBound'>): void {
   configureDefaultModelElements(context);
   overrideModelElement(context, DefaultTypes.EDGE, HydraniumGEdge, GEdgeView);
}
