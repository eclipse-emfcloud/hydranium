/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractHydraniumSemanticTokenProvider, type SemanticTokenKind } from '@hydranium/core/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver';
import { BookstoreNode } from './ast.js';

/** Declarations and references share the token kind of their target type. */
export class BookstoreSemanticTokenProvider extends AbstractHydraniumSemanticTokenProvider {
   protected override getTokenKind(type: string): SemanticTokenKind | undefined {
      return type === BookstoreNode.$type ? SemanticTokenTypes.class : undefined;
   }
}
