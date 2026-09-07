/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, DefaultCommentProvider } from '@hydranium/langium';
import type { HydraniumLanguageServices } from '../language-module.js';

/**
 * Comment provider that survives CST residency shedding.
 *
 * Hover and completion documentation read the TARGET node's preceding comment
 * through Langium's `DefaultCommentProvider.getComment`, which resolves it from
 * the node's live `$cstNode` — exactly what a residency policy sheds for a
 * closed, idle document. Those are read-only LSP requests that never run a
 * build, so nothing would restore the CST and a shed target's documentation
 * would silently come back empty.
 *
 * Read-side CST rehydration, the documentation sibling of
 * `DefaultNameProvider.getNameNode`: restore the CST on demand before reading.
 * A no-op while the CST is resident (every parsed node has a `$cstNode`), so
 * behaviour is unchanged unless a residency policy has shed the document.
 */
export class HydraniumCommentProvider extends DefaultCommentProvider {
   constructor(protected readonly languageServices: HydraniumLanguageServices) {
      super(languageServices);
   }

   override getComment(node: AstNode): string | undefined {
      this.languageServices.shared.workspace.CstResidencyService.rehydrateNode(node);
      return super.getComment(node);
   }
}
