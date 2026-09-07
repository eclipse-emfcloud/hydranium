/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode, AstUtils } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type ElementKeyProvider } from './element-key-provider.js';

/**
 * Positional {@link ElementKeyProvider} — delegates to Langium's
 * `AstNodeLocator.getAstNodePath` for a path like
 * `/elements@0/children@2`.
 *
 * Use when the adopter is read-only / LSP-only with no diagram editor,
 * or when sibling order is semantically meaningful and reorder is rare.
 *
 * # Stability profile
 *
 * - **Stable across all renames** — no names appear in the path.
 * - **Always unique within a document** — positional segments are
 *   unique by AST construction.
 * - **Flips on sibling reorder / mid-array insert / mid-array delete**.
 */
export class PositionalKeyProvider implements ElementKeyProvider {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: LogNameOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   getElementKey(node?: AstNode): string | undefined {
      if (!node) {
         return undefined;
      }
      return this.services.workspace.AstNodeLocator.getAstNodePath(node);
   }

   /**
    * Self-resolving: `getAstNodePath` is invertible via `getAstNode`. The
    * path is document-absolute, so `context` only identifies the document —
    * resolution runs from its root regardless of where `context` sits.
    */
   resolveElement(key: string, context: AstNode): AstNode | undefined {
      const root = AstUtils.findRootNode(context);
      return this.services.workspace.AstNodeLocator.getAstNode(root, key);
   }
}
