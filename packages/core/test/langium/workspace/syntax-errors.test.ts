/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LangiumDocument } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { hasSkippedText } from '../../../src/langium/workspace/syntax-errors.js';

function documentOf(text: string, parserErrors: number): LangiumDocument {
   return {
      parseResult: { value: {}, parserErrors: Array.from({ length: parserErrors }, () => ({})), lexerErrors: [] },
      textDocument: { getText: () => text }
   } as unknown as LangiumDocument;
}

describe('hasSkippedText', () => {
   it.each([
      ['text that parses', 'process P for E {}', 0, false],
      ['text with a parser error', 'process P for', 1, true],
      ['a comment alone with a parser error', '// note', 1, true],
      ['empty text with a parser error', '', 1, false],
      ['blank text with a parser error', ' \n\t', 1, false]
   ])('answers for %s', (_label, text, parserErrors, skipped) => {
      expect(hasSkippedText(documentOf(text, parserErrors))).toBe(skipped);
   });
});
