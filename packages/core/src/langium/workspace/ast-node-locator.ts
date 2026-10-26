/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, DefaultAstNodeLocator } from '@hydranium/langium';

/**
 * Framework `AstNodeLocator`. Returns the same paths as Langium's, built as
 * one flat string: Langium's recursive `+` leaves V8 a rope of up to two cons
 * cells per level, retained by every description and reference description
 * in the index. Interning the paths would save more but keeps one pool entry
 * per list index ever seen, deleted documents' paths included.
 *
 * Ancestors' segments come from `getPathSegment`, not from `getAstNodePath`,
 * so an override of `getAstNodePath` for one node does not reach its
 * descendants' paths; override `getPathSegment` for that.
 */
export class HydraniumAstNodeLocator extends DefaultAstNodeLocator {
   override getAstNodePath(node: AstNode): string {
      const segments: string[] = [];
      for (let current = node; current.$container; current = current.$container) {
         segments.push(this.getPathSegment(current));
      }
      // The root's empty segment gives the leading separator; a root alone yields ''.
      segments.push('');
      return segments.reverse().join(this.segmentSeparator);
   }
}
