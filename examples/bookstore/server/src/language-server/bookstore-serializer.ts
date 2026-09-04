/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Concrete-syntax emitter for Bookstore — the parser's inverse, turning a
// model back into text this grammar accepts. Derived from the starter grammar
// exactly as `generated/ast.ts` is, so replacing the grammar replaces this too.
//
// Without it every structured write fails: the framework's default binding at
// `services.serializer.Serializer` THROWS, because a concrete syntax is
// language knowledge no framework can derive. `ModelService.update` / `save`,
// the data head's `saveModelDocument` and a GLSP `SaveModelAction` all reach
// it.
//
// `AbstractSerializer`'s generic property walk lays out FORMAT-structured
// output — its YAML and JSON subclasses are what it exists for — and cannot
// produce a keyword-delimited syntax like `node a -> b`. So `serializeNode` is
// a per-`$type` emitter here and the two array hooks are unreachable.

import { AbstractSerializer } from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import { type BookstoreModel, type BookstoreNode, isBookstoreModel, isBookstoreNode } from './ast.js';

export class BookstoreSerializer extends AbstractSerializer<BookstoreModel> {
   protected override serializeNode(node: AstNode | Record<string, unknown>): string {
      if (isBookstoreModel(node)) {
         return node.nodes.map(child => this.emitNode(child)).join('\n');
      }
      if (isBookstoreNode(node)) {
         return this.emitNode(node);
      }
      // Defensive: a rule added to the grammar with no emitter added here.
      throw new Error(`BookstoreSerializer: no emitter for $type ${(node as AstNode).$type}`);
   }

   /** Unreachable — this grammar's one list is emitted by its `BookstoreModel` parent. */
   protected override serializeArray(): string {
      throw new Error('BookstoreSerializer: arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /** Unreachable — same reasoning as {@link serializeArray}. */
   protected override serializeReferenceArray(): string {
      throw new Error('BookstoreSerializer: reference arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /**
    * `serializeReferenceText` rather than `node.target?.$refText`: it is the one
    * read that spans BOTH input shapes. A transfer model reaching
    * `serializeTransfer` carries `target` as a plain string rather than a
    * `Reference`, and a serializer that reaches for `$refText` directly emits
    * the AST correctly and drops every reference on the transfer path.
    */
   private emitNode(node: BookstoreNode): string {
      const target = this.serializeReferenceText(node.target);
      return target === undefined ? `node ${node.name}` : `node ${node.name} -> ${target}`;
   }
}
