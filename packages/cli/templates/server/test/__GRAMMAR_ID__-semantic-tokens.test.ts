import { parseHelper } from '@hydranium/core/testing';
import { SemanticTokensDecoder } from '@hydranium/langium/lsp';
import { describe, expect, it } from 'vitest';
import { create__NAME__Services } from '../src/language-server/__PROJECT_ID__-module.js';

describe('__GRAMMAR__ semantic tokens', () => {
   it.each([false, true])('colours declarations and references with lexical highlighting %s', async lexical => {
      const { __GRAMMAR__ } = create__NAME__Services({}, { highlightKeywords: lexical, highlightComments: lexical });
      const document = await parseHelper(__GRAMMAR__)('// comment\nnode first -> second\nnode second', {
         documentUri: 'file:///tokens.__EXTENSION__',
         validation: true
      });
      expect(document.diagnostics).toEqual([]);
      const provider = __GRAMMAR__.lsp.SemanticTokenProvider!;
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
