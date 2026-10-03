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
   it('builds an envelope with a model block, and no diagnostics or text unless given', () => {
      const doc = TransferDocument.create<FakeRoot>('file:///A.fake', 3, { $type: 'FakeRoot', name: 'a' }, 'hash');
      expect(doc).toEqual({ uri: 'file:///A.fake', model: { root: { $type: 'FakeRoot', name: 'a' }, version: 3, hash: 'hash' } });
      expect(TransferDocument.isLoaded(doc)).toBe(true);
   });

   it('accepts an explicit diagnostics array and text block', () => {
      const diags: TransferDiagnostic[] = [{ type: 'validation-error', severity: 'error', message: 'boom', element: 'a', code: 'x' }];
      const text = { version: 4, hash: 'text', dirty: true };
      const doc = TransferDocument.create<FakeRoot>('file:///A.fake', 1, { $type: 'FakeRoot', name: 'a' }, 'hash', diags, text);
      expect(doc.model?.diagnostics).toBe(diags);
      expect(doc.text).toBe(text);
   });
});

describe('TransferDocument.absent', () => {
   it('carries neither a model nor a text block', () => {
      const doc = TransferDocument.absent<FakeRoot>('file:///A.fake');
      expect(doc).toEqual({ uri: 'file:///A.fake' });
      expect(TransferDocument.isLoaded(doc)).toBe(false);
   });
});
