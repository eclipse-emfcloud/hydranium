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

   it('keeps the CRLF ending of a file whose body has no line break to match', () => {
      expect(roundTrip('body\r\n\r\n', 'body')).toBe('body\r\n\r\n');
   });

   it('gives a CRLF ending the LF line terminators of a body the serializer emits with LF', () => {
      // Kept verbatim, a rewritten document would carry its only CRLFs at the very end.
      expect(roundTrip('a\r\nb\r\n\r\n', 'a\nb')).toBe('a\nb\n\n');
   });

   it('gives the ending the CRLF line terminators of a body the serializer emits with them', () => {
      expect(roundTrip('a\r\nb\r\n\r\n', 'a\r\nb')).toBe('a\r\nb\r\n\r\n');
   });

   it('gives a created document the CRLF line terminator of a body emitted with CRLF', () => {
      expect(roundTrip('', 'a\r\nb')).toBe('a\r\nb\r\n');
   });

   it("takes the terminator of the body's first line break, not a CRLF inside a value", () => {
      expect(roundTrip('x {\n  d "l1\r\nl2"\n}\n', 'x {\n  d "l1\r\nl2"\n}')).toBe('x {\n  d "l1\r\nl2"\n}\n');
   });

   it.each([
      ['a CRLF body', 'a\r\nb', 'a\r\nb\r\n'],
      ['an LF body', 'a\nb', 'a\nb\n'],
      ['a body with no line break', 'ab', 'ab\r\n']
   ])("matches a subclass's CRLF default ending to %s", (_body, serialized, expected) => {
      class CrlfDefault extends DocumentEndingPreserver {
         protected override readonly defaultEnding = '\r\n';
      }
      const preserver = new CrlfDefault();
      expect(preserver.apply(serialized, preserver.extract(documentOf('')))).toBe(expected);
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

   it.each(['', '\n\n', ' \r\n'])('answers the default ending for a blank document %j', source => {
      // A created document has no ending of its own to keep.
      expect(new DocumentEndingPreserver().extract(documentOf(source))).toBe('\n');
   });
});
