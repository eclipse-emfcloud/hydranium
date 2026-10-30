/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The starter delete handler for the Bookstore diagram: removes a
// `BookstoreNode`, or the reference an edge draws.
//
// Deleting a node also clears every reference to it in this document, so
// `node A -> B` becomes `node A` rather than keeping a reference that no longer
// resolves. A reference stays when the name still resolves: to another node of
// it here, or to one another document declares. A reference from another
// document is not this operation's to edit: it is left, and reported there as a
// link error. A node drawn for another document's target is not deletable, and
// its id finds no node here.
//
// Like the create handler, it edits the operation's copy, which the operation
// writes once, with undo and redo applying that one change.

import { type Command, DeleteElementOperation, GEdge, JsonOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { removeChildren } from '@hydranium/core';
import { HydraniumGlspRecordingCommand } from '@hydranium/glsp-server';
import { UriUtils } from '@hydranium/langium';
import type { Mutable } from '@hydranium/protocol';
import { injectable } from 'inversify';
import type { BookstoreNode } from '../../language-server/ast.js';
import type { BookstoreGlspState } from './state.js';

@injectable()
export class BookstoreDeleteOperationHandler extends JsonOperationHandler {
   readonly operationType = DeleteElementOperation.KIND;

   declare protected modelState: BookstoreGlspState;

   override createCommand(operation: DeleteElementOperation): MaybePromise<Command | undefined> {
      return new HydraniumGlspRecordingCommand(this.modelState, 'Delete', () => {
         const index = this.modelState.index;
         const root = this.modelState.sourceRoot;
         // The first node with the id, which is the one the diagram draws for a repeated name.
         const nodeOf = (id: string): BookstoreNode | undefined => root.nodes.find(node => index.findId(node) === id);
         const deleted = new Set<BookstoreNode>();
         // The nodes whose reference a deleted edge drew.
         const unlinked = new Set<BookstoreNode>();
         for (const elementId of operation.elementIds) {
            const element = index.find(elementId);
            const node = nodeOf(element instanceof GEdge ? element.sourceId : elementId);
            if (node !== undefined) {
               (element instanceof GEdge ? unlinked : deleted).add(node);
            }
         }
         const remaining = new Set(root.nodes.filter(node => !deleted.has(node)).map(node => node.name));
         const indexManager = index.languageServicesFor(root)?.shared.workspace.IndexManager;
         const stillResolves = (target: BookstoreNode): boolean =>
            remaining.has(target.name) ||
            (indexManager
               ?.allElements(target.$type)
               .some(element => element.name === target.name && !UriUtils.equals(element.documentUri, this.modelState.sourceUri)) ??
               false);
         for (const node of root.nodes) {
            const target = node.target?.ref;
            if (unlinked.has(node) || (target !== undefined && deleted.has(target) && !stillResolves(target))) {
               (node as Mutable<BookstoreNode>).target = undefined;
            }
         }
         removeChildren(root.nodes, deleted);
      });
   }
}
