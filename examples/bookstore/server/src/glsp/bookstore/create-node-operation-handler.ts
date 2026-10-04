/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The starter operation handler for the Bookstore diagram: the tool-palette
// entry that creates a `BookstoreNode`.
//
// **Deleting this file and its `configureOperationHandlers` registration in
// `diagram-module.ts` gives a read-only viewer**, and nothing else has to change
// — creation is offered through the palette rather than through a type hint, so
// every hint in `diagram-configuration.ts` is already `false`. The scaffold emits
// the editable direction because that asymmetry runs one way: editable →
// read-only is a deletion the compiler checks, while read-only → editable is
// authoring against a seam you have not used yet.
//
// **It edits the operation's working copy.** A handler runs inside an operation,
// where `sourceRoot` is a copy of the built root: the recording command's
// runnable appends to the copy, and the operation writes the copy's text through
// the grammar's `Serializer` once, gated on the version the copy was made at,
// with undo and redo replaying that one change. A command that writes the
// document itself instead reads no text off the copy, which has no `$document`,
// and the operation's own write then overwrites it.
//
// **The drop location is discarded.** `needsClientLayout` is `true` and the
// starter grammar persists no bounds, so there is nowhere to put a coordinate: the
// node is appended at the end of the document and the client places it.
//
// Like `types.ts`, `gmodel-factory.ts` and `diagram-configuration.ts`, this file
// knows the starter grammar's shape — the `nodes` list and the `BookstoreNode`
// it holds. Replacing the grammar means replacing these four together.

import { type Command, type CreateNodeOperation, JsonCreateNodeOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { appendChild } from '@hydranium/core';
import { HydraniumGlspRecordingCommand } from '@hydranium/glsp-server';
import { findNextUnique } from '@hydranium/protocol';
import { injectable } from 'inversify';
import type { BookstoreNode } from '../../language-server/ast.js';
import { BOOKSTORE_NODE_TYPE } from './types.js';
import type { BookstoreGlspState } from './state.js';

/** Proposed name for a new node, uniquified against the ones the document already has. */
const NODE_NAME_STEM = 'Node';

@injectable()
export class BookstoreCreateNodeOperationHandler extends JsonCreateNodeOperationHandler {
   declare protected modelState: BookstoreGlspState;

   /** The palette's word for the thing it creates, so a noun rather than an action. */
   override readonly label = 'BookstoreNode';
   elementTypeIds = [BOOKSTORE_NODE_TYPE];

   override createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
      if (!this.elementTypeIds.includes(operation.elementTypeId)) {
         return undefined;
      }
      return new HydraniumGlspRecordingCommand(this.modelState, this.label, () => {
         const root = this.modelState.sourceRoot;
         const name = findNextUnique(
            NODE_NAME_STEM,
            root.nodes.map(node => node.name)
         );
         appendChild(root, 'nodes', root.nodes, { $type: 'BookstoreNode', name } as BookstoreNode);
      });
   }
}
