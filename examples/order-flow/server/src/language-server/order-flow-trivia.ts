/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CommentPreserver, type TriviaContribution, type TriviaRegistry, type HydraniumLanguageServices } from '@hydranium/core';
import { type AstNode } from '@hydranium/langium';
import { isBranch, isDiagramNode, isRead, isTransition, isWrite } from './ast.js';

/**
 * Identifies unnamed `.layout` and `.process` nodes by their semantic references.
 *
 * The framework keys a node on the identity its `NameProvider` reports, and a
 * `DiagramNode` carries none on any property — so without this every comment
 * inside a `.layout` body is dropped, which is the whole body, and that file is
 * written on every diagram drag.
 *
 * `flowNode` supplies the identity instead. A layout entry positions one flow
 * node, so its reference text is unique among its siblings and survives an entry
 * being added or removed — the property an anchor key has to have. A same-count
 * reorder is deliberately treated as ambiguous with exchanged identities.
 * The grammar does not ENFORCE uniqueness, and two entries for one flow node
 * would collide; the framework drops a colliding key rather than guessing, so
 * such a file loses those comments instead of moving them. Transitions use
 * their endpoint pair, effects their entity and field, and branches their
 * label within their named parent. Duplicate keys are dropped in the same way.
 */
export class OrderFlowCommentPreserver extends CommentPreserver {
   protected override anchorKey(node: AstNode): string | undefined {
      if (isDiagramNode(node)) {
         const flowNode = node.flowNode.$refText;
         return flowNode ? `DiagramNode#${this.escapeKeySegment(flowNode)}` : undefined;
      }
      if (isBranch(node) || isRead(node) || isWrite(node) || isTransition(node)) {
         const parent = super.anchorKey(node.$container);
         if (parent === undefined) {
            return undefined;
         }
         const identity = isBranch(node)
            ? node.label
            : isTransition(node)
              ? `${node.source.$refText}->${node.target.$refText}`
              : `${node.entity.$refText}.${node.field.$refText}`;
         return identity ? `${parent}/${node.$type}#${this.escapeKeySegment(identity)}` : undefined;
      }
      return super.anchorKey(node);
   }
}

/**
 * Replaces the framework's comment preserver, bound at
 * `trivia.preservers.comments` — the same sub-key, because Langium's deep-merge
 * is last-wins and swapping this one is the point. The document-ending
 * preserver stays framework-supplied under its own sub-key.
 */
export class OrderFlowTriviaContribution implements TriviaContribution {
   constructor(protected readonly services: HydraniumLanguageServices) {}

   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new OrderFlowCommentPreserver(this.services));
   }
}
