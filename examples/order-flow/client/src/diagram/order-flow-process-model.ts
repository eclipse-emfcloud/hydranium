/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiamondNode } from '@eclipse-glsp/client';

/**
 * The client-side model class for a `gateway`.
 *
 * **A view draws a shape; only the MODEL decides where an edge meets it.** The
 * router asks the target element for its `anchorKind` and resolves an
 * `IAnchorComputer` from it, and sprotty's shape classes are exactly the classes
 * that override it — `CircularNode`, `RectangularNode`, `DiamondNode`
 * (`sprotty/lib/lib/model`). GLSP's plain `GNode` is an alias for `SNodeImpl`,
 * whose anchor is rectangular, so registering it with a `DiamondNodeView`
 * produces a diamond that every edge still aims at the corners of its bounding
 * box: transitions visibly stop short in the empty triangles beside the shape.
 *
 * Deriving from `DiamondNode` is the whole fix — it contributes `anchorKind`
 * and nothing else, and GLSP's routing module already binds the matching
 * `DiamondAnchor` / `ManhattanDiamondAnchor` computers.
 *
 * A named subclass rather than `DiamondNode` itself, so the registration reads
 * as a decision about gateways and there is somewhere to put gateway state if
 * the example ever grows any. It deliberately does NOT pin a `size` the way the
 * GLSP workflow example's `ControlNode` does: a gateway here is sized by its
 * name label and by the `.layout` file, not by the notation.
 */
export class ProcessGatewayNode extends DiamondNode {}
