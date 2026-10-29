/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, type ParseResult } from '@hydranium/langium';

/**
 * Whether `parseResult` has a lexer error, a parser error or an error a token
 * builder reported. The AST of such a parse lacks what the parser skipped, so
 * text serialized from it deletes that. A client reads the same from
 * diagnostics with `TransferDiagnostic.hasSyntaxErrors`, which can miss some.
 */
export function hasSyntaxErrors(parseResult: ParseResult): boolean {
   const lexing = parseResult.lexerReport?.diagnostics ?? [];
   return (
      parseResult.parserErrors.length > 0 ||
      parseResult.lexerErrors.length > 0 ||
      lexing.some(diagnostic => (diagnostic.severity ?? 'error') === 'error')
   );
}

/**
 * Whether the parse of `document` lacks some of its text: it has syntax
 * errors and the text is not blank. A model serialized from its AST deletes
 * that text, so a write of one is refused. Blank text has nothing to lose.
 */
export function hasSkippedText(document: LangiumDocument): boolean {
   return hasSyntaxErrors(document.parseResult) && document.textDocument.getText().trim() !== '';
}
