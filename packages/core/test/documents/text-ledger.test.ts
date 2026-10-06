/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, textHash } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultTextLedger } from '../../src/documents/text-ledger.js';

const KEY = 'file:///a.x' as CanonicalUri;
const documentAt = (version: number, text: string): TextDocument => TextDocument.create(KEY, 'plaintext', version, text);

describe('DefaultTextLedger.openingVersion', () => {
   it('answers nothing for a document with no record', () => {
      expect(new DefaultTextLedger().openingVersion(KEY, 'a')).toBeUndefined();
   });

   it('continues the record: the same version for the same text, one on for other text', () => {
      const ledger = new DefaultTextLedger();
      ledger.record(KEY, documentAt(3, 'a'));
      expect(ledger.openingVersion(KEY, 'a')).toBe(3);
      expect(ledger.openingVersion(KEY, 'b')).toBe(4);
   });
});

describe('DefaultTextLedger.reconcile', () => {
   it('starts a record at 0, keeps it for the same text and steps it for other text', () => {
      const ledger = new DefaultTextLedger();
      expect(ledger.reconcile(KEY, 'a')).toBe(0);
      expect(ledger.reconcile(KEY, 'a')).toBe(0);
      expect(ledger.reconcile(KEY, 'b')).toBe(1);
      expect(ledger.recordOf(KEY)).toEqual({ version: 1, hash: textHash('b') });
   });
});

describe('DefaultTextLedger.hashOf', () => {
   it('hashes again once the document moves to a new version', () => {
      const ledger = new DefaultTextLedger();
      const document = documentAt(1, 'a');
      expect(ledger.hashOf(document)).toBe(textHash('a'));
      TextDocument.update(document, [{ text: 'b' }], 2);
      expect(ledger.hashOf(document)).toBe(textHash('b'));
   });
});

describe('DefaultTextLedger authors', () => {
   it('answers the author of a version, else of the latest, until cleared', () => {
      const ledger = new DefaultTextLedger();
      ledger.setAuthor(KEY, 0, 'editor');
      ledger.setAuthor(KEY, 2, 'form');
      expect(ledger.authorOf(KEY, 0)).toBe('editor');
      expect(ledger.authorOf(KEY, 1)).toBeUndefined();
      expect(ledger.authorOf(KEY)).toBe('form');
      ledger.clearAuthors(KEY);
      expect(ledger.authorOf(KEY)).toBeUndefined();
   });
});
