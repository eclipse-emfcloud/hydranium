/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type TransferDiagnostic, TransferDocument, type TransferElement } from '../src';

interface FakeRoot extends TransferElement {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

describe('TransferDocument.create', () => {
   it('builds an envelope with uri / version / root and an empty diagnostics array by default', () => {
      const doc = TransferDocument.create<FakeRoot>('file:///A.fake', 3, { $type: 'FakeRoot', name: 'a' });
      expect(doc.uri).toBe('file:///A.fake');
      expect(doc.version).toBe(3);
      expect(doc.root).toEqual({ $type: 'FakeRoot', name: 'a' });
      expect(doc.diagnostics).toEqual([]);
   });

   it('accepts an explicit diagnostics array', () => {
      const diags: TransferDiagnostic[] = [{ type: 'validation-error', severity: 'error', message: 'boom', element: 'a', code: 'x' }];
      const doc = TransferDocument.create<FakeRoot>('file:///A.fake', 1, { $type: 'FakeRoot', name: 'a' }, diags);
      expect(doc.diagnostics).toBe(diags);
   });
});
