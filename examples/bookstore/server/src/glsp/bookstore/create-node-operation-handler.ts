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
// **It composes TEXT rather than mutating the AST.** The source model of
// `FullTextHydraniumGlspState` is the document text, and reading it back through
// `state.sourceModel` serialises the AST through the per-URI `Serializer`, which
// this scaffold does not bind — so that getter throws until you do. Appending a
// declaration to the text the parser last read needs no serializer, which is what
// makes a scaffolded diagram editable on day one. Bind a `Serializer` at
// `services.serializer.Serializer` and this becomes a
// `HydraniumGlspRecordingCommand` over `state.sourceModel` instead — the same
// binding the diagram's own save action needs.
//
// **The drop location is discarded.** `needsClientLayout` is `true` and the
// starter grammar persists no bounds, so there is nowhere to put a coordinate: the
// node is appended at the end of the document and the client places it.
//
// Like `types.ts`, `gmodel-factory.ts` and `diagram-configuration.ts`, this file
// knows the starter grammar's concrete syntax — the `node` keyword below is that
// grammar's. Replacing the grammar means replacing these four together.

import { type Command, type CreateNodeOperation, JsonCreateNodeOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { findNextUnique } from '@hydranium/protocol';
import { injectable } from 'inversify';
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
      const state = this.modelState;
      const before = this.documentText();
      const after = this.withNode(
         before,
         findNextUnique(
            NODE_NAME_STEM,
            state.sourceRoot.nodes.map(node => node.name)
         )
      );
      // Whole-document undo, which is all a full-text source model can offer: it
      // has exactly one field, so there is nothing to merge a concurrent edit into.
      return {
         execute: () => state.updateSourceModel({ text: after }),
         undo: () => state.updateSourceModel({ text: before }),
         redo: () => state.updateSourceModel({ text: after })
      };
   }

   /** The text the captured source root was parsed from — the baseline an edit appends to. */
   protected documentText(): string {
      return this.modelState.sourceRoot.$document?.textDocument.getText() ?? '';
   }

   /** `text` with one more node declaration, under exactly one trailing newline. */
   protected withNode(text: string, name: string): string {
      const body = text.trimEnd();
      const declaration = `node ${name}`;
      return body.length === 0 ? `${declaration}\n` : `${body}\n${declaration}\n`;
   }
}
