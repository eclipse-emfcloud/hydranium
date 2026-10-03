/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode } from '@hydranium/langium';
import { AstDocument } from '../../src/documents/ast-document-manager.js';
import { type AstDiagnostic } from '../../src/langium/validation/document-validator.js';

/** Any range; the envelope copies diagnostics through without reading into them. */
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

interface FakeAst extends AstNode {
   readonly $type: 'FakeAst';
   readonly name: string;
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
      const diags: AstDiagnostic[] = [{ range: RANGE, severity: 1, message: 'boom' }];
      const doc = AstDocument.create<FakeAst>('file:///A.fake', 1, { $type: 'FakeAst', name: 'a' } as FakeAst, diags);
      expect(doc.diagnostics).toBe(diags);
   });
});
