/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { parseHelper } from '@hydranium/core/testing';
import { SemanticTokensDecoder } from '@hydranium/langium/lsp';
import { describe, expect, it } from 'vitest';
import { createBookstoreServices } from '../src/language-server/bookstore-module.js';

describe('Bookstore semantic tokens', () => {
   it.each([false, true])('colours declarations and references with lexical highlighting %s', async lexical => {
      const { Bookstore } = createBookstoreServices({}, { highlightKeywords: lexical, highlightComments: lexical });
      const document = await parseHelper(Bookstore)('// comment\nnode first -> second\nnode second', {
         documentUri: 'file:///tokens.bookstore',
         validation: true
      });
      expect(document.diagnostics).toEqual([]);
      const provider = Bookstore.lsp.SemanticTokenProvider!;
      const tokens = await provider.semanticHighlight(document, { textDocument: { uri: document.uri.toString() } });
      const decoded = SemanticTokensDecoder.decode(tokens, provider.tokenTypes, document).map(token => ({
         text: token.text,
         type: token.tokenType
      }));
      expect(decoded).toEqual([
         ...(lexical
            ? [
                 { text: '// comment', type: 'comment' },
                 { text: 'node', type: 'keyword' }
              ]
            : []),
         { text: 'first', type: 'class' },
         ...(lexical ? [{ text: '->', type: 'keyword' }] : []),
         { text: 'second', type: 'class' },
         ...(lexical ? [{ text: 'node', type: 'keyword' }] : []),
         { text: 'second', type: 'class' }
      ]);
   });
});
