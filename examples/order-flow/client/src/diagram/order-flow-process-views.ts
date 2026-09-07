/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GEdge, GEdgeView, Point, type RenderingContext, angleOfPoint, svg, toDegrees } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

/**
 * A `.process` connection, drawn with an arrowhead at its target.
 *
 * **GLSP's `GEdgeView` draws a bare `<path>` and nothing else** — its
 * `renderAdditionals` hook returns an empty list, and there is no arrowhead view
 * in the client to register instead. Every connection in this diagram is
 * directed (`transition Pay -> PaymentOk`, `yes -> Pick`), so an undecorated
 * line loses the one thing the notation is asserting: which way the flow runs.
 * Two nodes joined by a plain segment read as "related", not "then".
 *
 * The arrow is built from the last ROUTE segment rather than from the source and
 * target positions, so it stays on the line for a routed or reconnected edge
 * instead of pointing at where the target happens to sit.
 *
 * `class-arrow` is what the stylesheet hangs the fill on: the arrow is a filled
 * triangle while the line it terminates is a stroke with no fill, so the two
 * cannot share a rule.
 *
 * Written against sprotty's `svg` factory directly rather than as JSX. That
 * factory IS what the `/** @jsx svg *\/` pragma compiles to, and calling it
 * keeps this package free of a JSX toolchain it otherwise has no use for — its
 * `tsconfig.json` configures none.
 *
 * The return type is inferred rather than written, because spelling it means
 * importing `VNode` from `snabbdom` — a transitive dependency of the GLSP client
 * that this package does not declare, and `import/no-extraneous-dependencies`
 * is right to reject reaching through the graph for it.
 */
@injectable()
export class ProcessEdgeView extends GEdgeView {
   protected override renderAdditionals(edge: GEdge, segments: Point[], context: RenderingContext) {
      const additionals = super.renderAdditionals(edge, segments, context);
      const penultimate = segments[segments.length - 2];
      const last = segments[segments.length - 1];
      if (!penultimate || !last) {
         return additionals;
      }
      const angle = toDegrees(angleOfPoint(Point.subtract(penultimate, last)));
      additionals.push(
         svg('path', {
            'class-sprotty-edge': true,
            'class-arrow': true,
            d: 'M 0,0 L 9,-3.5 L 9,3.5 Z',
            transform: `rotate(${angle} ${last.x} ${last.y}) translate(${last.x} ${last.y})`
         })
      );
      return additionals;
   }
}
