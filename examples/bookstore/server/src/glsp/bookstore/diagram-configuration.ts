/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Diagram configuration for the Bookstore diagram.
//
// **Every hint is `false`, and that is not the same as read-only.** The starter
// BookstoreCreateNodeOperationHandler makes this diagram editable through the
// tool palette, which GLSP assembles from the create handlers' trigger actions —
// there is no `creatable` hint. What the hints govern is delete / reparent /
// reposition / resize, and nothing backs those, so declaring one would offer a
// gesture whose operation the server rejects: a worse failure than the tool being
// absent. Turn a hint on in the same change that adds its handler.
//
// `needsClientLayout` is `true` and `layoutKind` is `NONE`: the starter grammar
// persists no bounds, so the client measures and places everything. That is also
// why `ChangeBoundsOperation` is a poor second handler to add — with nowhere in
// the grammar to write a position, a move never reaches the text and is lost on
// the next reload.

import { type GModelElementConstructor } from '@eclipse-glsp/graph';
import {
   type DiagramConfiguration,
   type EdgeTypeHint,
   ServerLayoutKind,
   type ShapeTypeHint,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { BOOKSTORE_EDGE_TYPE, BOOKSTORE_NODE_TYPE } from './types.js';

@injectable()
export class BookstoreDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind: ServerLayoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout: boolean = true;
   readonly animatedUpdate: boolean = false;

   readonly typeMapping: Map<string, GModelElementConstructor> = getDefaultMapping();

   readonly shapeTypeHints: ShapeTypeHint[] = [
      {
         elementTypeId: BOOKSTORE_NODE_TYPE,
         deletable: false,
         reparentable: false,
         repositionable: false,
         resizable: false
      }
   ];

   readonly edgeTypeHints: EdgeTypeHint[] = [
      {
         elementTypeId: BOOKSTORE_EDGE_TYPE,
         deletable: false,
         repositionable: false,
         routable: false,
         sourceElementTypeIds: [BOOKSTORE_NODE_TYPE],
         targetElementTypeIds: [BOOKSTORE_NODE_TYPE]
      }
   ];
}
