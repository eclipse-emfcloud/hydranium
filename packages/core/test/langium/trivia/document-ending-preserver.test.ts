/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The whitespace a file ended with, which no serializer can decide for itself.
 *
 * Needs no grammar: the preserver reads the document's text and nothing else,
 * so the cases that matter are about what counts as an ending and which line
 * terminator survives.
 */

import { describe, expect, it } from 'vitest';
import { type LangiumDocument } from '@hydranium/langium';
import { DocumentEndingPreserver } from '../../../src/langium/trivia/document-ending-preserver.js';

/** A document that answers `getText()` and nothing else, which is all this reads. */
function documentOf(text: string): LangiumDocument {
   return { textDocument: { getText: () => text } } as LangiumDocument;
}

function roundTrip(source: string, serialized: string): string {
   const preserver = new DocumentEndingPreserver();
   return preserver.apply(serialized, preserver.extract(documentOf(source)));
}

describe('DocumentEndingPreserver', () => {
   it('keeps several trailing newlines rather than normalising to one', () => {
      expect(roundTrip('body\n\n\n', 'body')).toBe('body\n\n\n');
   });

   it('keeps the absence of a final newline', () => {
      expect(roundTrip('body', 'body\n')).toBe('body');
   });

   it('keeps a trailing blank line made of spaces', () => {
      expect(roundTrip('body\n   \n', 'body')).toBe('body\n   \n');
   });

   it('reduces a CRLF ending to the LF the serializer emits', () => {
      // Kept verbatim, a rewritten CRLF document would carry its only CRLFs at
      // the very end — the one thing here that cannot be preserved.
      expect(roundTrip('body\r\n\r\n', 'body')).toBe('body\n\n');
   });

   it('leaves an LF ending alone rather than touching every document', () => {
      expect(new DocumentEndingPreserver().extract(documentOf('body\n\n'))).toBe('\n\n');
   });

   it('replaces whatever the serializer ended with, not just what it lacks', () => {
      // The serializer has no prior file to consult, so its ending is discarded
      // rather than merged: the document's own is the only one with authority.
      expect(roundTrip('body', 'body\n\n\n')).toBe('body');
   });

   it('answers an empty ending for a document with none', () => {
      expect(new DocumentEndingPreserver().extract(documentOf('body'))).toBe('');
   });
});
