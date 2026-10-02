/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { NO_MATCHING_VERSION } from '@hydranium/protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { snapshotVersion } from '../../src/documents/hydranium-text-documents.js';
import { makeFakeAstNode } from '../../src/testing/fake-document.js';

const URI = 'file:///a.x';

/** A root parsed from `text`, or one that keeps no syntax tree. */
function root(text?: string): AstNode {
   return makeFakeAstNode(text === undefined ? { $type: 'Element' } : { $type: 'Element', $cstNode: { root: { fullText: text } } });
}

function built(textDocument: TextDocument, value: AstNode): LangiumDocument {
   return { textDocument, parseResult: { value } } as unknown as LangiumDocument;
}

function text(version: number, content: string): TextDocument {
   return TextDocument.create(URI, 'plaintext', version, content);
}

describe('snapshotVersion', () => {
   it('answers the store version while the store holds the text the root was parsed from', () => {
      expect(snapshotVersion(built(text(3, 'a'), root('a')), text(9, 'a'))).toBe(9);
   });

   it('answers a version no write matches once the store holds other text', () => {
      expect(snapshotVersion(built(text(9, 'a'), root('a')), text(9, 'a b'))).toBe(NO_MATCHING_VERSION);
   });

   it('reads the root from the syntax tree, not from a text document the store updated in place', () => {
      const shared = text(1, 'a');
      const document = built(shared, root('a'));
      TextDocument.update(shared, [{ text: 'a b' }], 2);

      expect(snapshotVersion(document, shared)).toBe(NO_MATCHING_VERSION);
   });

   it("answers the built document's own version when the store holds no text for it", () => {
      expect(snapshotVersion(built(text(4, 'a'), root('a')), undefined)).toBe(4);
   });

   it('answers a version no write matches for a root the document has since replaced', () => {
      const document = built(text(4, 'a b'), root('a b'));

      expect(snapshotVersion(document, undefined, root('a'))).toBe(NO_MATCHING_VERSION);
   });

   it("matches a root without a syntax tree through its document's own text", () => {
      expect(snapshotVersion(built(text(3, 'a'), root()), text(9, 'a'))).toBe(9);
      expect(snapshotVersion(built(text(3, 'a'), root()), text(9, 'a b'))).toBe(NO_MATCHING_VERSION);
   });

   it('answers a version no write matches for a root without a syntax tree whose document is the store’s', () => {
      const shared = text(2, 'a');

      expect(snapshotVersion(built(shared, root()), shared)).toBe(NO_MATCHING_VERSION);
   });
});
