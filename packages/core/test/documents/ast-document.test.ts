/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { AstDocument } from '../../src/documents/ast-document-manager.js';

interface FakeAst extends AstNode {
   readonly $type: 'FakeAst';
   readonly name: string;
}

function fakeDocument(uri: string, version: number, root: FakeAst, diagnostics?: unknown[]): LangiumDocument {
   return { textDocument: { uri, version }, parseResult: { value: root }, diagnostics } as unknown as LangiumDocument;
}

describe('AstDocument.create', () => {
   it('builds an envelope with uri / version / root and an empty diagnostics array by default', () => {
      const doc = AstDocument.create<FakeAst>('file:///A.fake', 7, { $type: 'FakeAst', name: 'a' } as FakeAst);
      expect(doc.uri).toBe('file:///A.fake');
      expect(doc.version).toBe(7);
      expect(doc.root).toEqual({ $type: 'FakeAst', name: 'a' });
      expect(doc.diagnostics).toEqual([]);
   });

   it('accepts an explicit diagnostics array', () => {
      const diags = [{ severity: 1, message: 'boom' }];
      const doc = AstDocument.create<FakeAst, { severity: number; message: string }>(
         'file:///A.fake',
         1,
         { $type: 'FakeAst', name: 'a' } as FakeAst,
         diags
      );
      expect(doc.diagnostics).toBe(diags);
   });
});

describe('AstDocument.from', () => {
   it('projects a LangiumDocument into an envelope, defaulting uri to the document uri', () => {
      const doc = AstDocument.from<FakeAst>(
         fakeDocument('file:///A.fake', 3, { $type: 'FakeAst', name: 'a' } as FakeAst, [{ severity: 1 }])
      );
      expect(doc.uri).toBe('file:///A.fake');
      expect(doc.version).toBe(3);
      expect(doc.root).toEqual({ $type: 'FakeAst', name: 'a' });
      expect(doc.diagnostics).toEqual([{ severity: 1 }]);
   });

   it('defaults diagnostics to [] when the document has none', () => {
      const doc = AstDocument.from<FakeAst>(fakeDocument('file:///A.fake', 0, { $type: 'FakeAst', name: 'a' } as FakeAst));
      expect(doc.diagnostics).toEqual([]);
   });

   it('takes uri and version from the LangiumDocument, with no override parameter', () => {
      // The signature is the assertion: `from` accepts nothing but the document,
      // so there is no seam through which a caller's uri could reach the
      // envelope. Whether the *manager* passes a subscriber's uri instead of the
      // document's is a different question, and one this constructor-level
      // fixture cannot pose — it holds a single uri, so both answers look alike.
      // The discriminating fixture (two divergent uris) lives with the manager.
      const doc = AstDocument.from<FakeAst>(fakeDocument('file:///real.fake', 5, { $type: 'FakeAst', name: 'a' } as FakeAst));
      expect(doc.uri).toBe('file:///real.fake');
      expect(doc.version).toBe(5);
   });
});
