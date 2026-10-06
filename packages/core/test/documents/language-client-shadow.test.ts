/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { asLanguageClientUri, type CanonicalUri } from '@hydranium/protocol';
import { describe, expect, test } from 'vitest';
import { Range, type TextDocumentsConfiguration, type TextEdit, uinteger } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultLanguageClientShadow, diffToEdits } from '../../src/documents/language-client-shadow.js';
import { type CapturedLine, makeCapturingTracer } from '../../src/testing/index.js';

/**
 * The default factories: these tests do not exercise a custom text-document
 * type, which the `HydraniumTextDocuments` integration tests cover end to end.
 */
const factories: TextDocumentsConfiguration<TextDocument> = { create: TextDocument.create, update: TextDocument.update };

function makeShadow(configuration = factories): { shadow: DefaultLanguageClientShadow; lines: CapturedLine[] } {
   const { tracer, lines } = makeCapturingTracer();
   return { shadow: new DefaultLanguageClientShadow(configuration, tracer), lines };
}

/**
 * Apply edits via LSP semantics (sorted descending, pre-edit positions)
 * and return the resulting text. Mirrors how Monaco / any compliant LSP
 * client applies them.
 */
function applyEdits(oldText: string, edits: TextEdit[]): string {
   const doc = TextDocument.create('mem://test', 'plaintext', 1, oldText);
   return TextDocument.applyEdits(doc, edits);
}

function roundTrip(oldText: string, newText: string): string {
   return applyEdits(oldText, diffToEdits(oldText, newText));
}

describe('diffToEdits', () => {
   test('identical texts produce no-op edits', () => {
      const text = 'line1\nline2\nline3\n';
      const edits = diffToEdits(text, text);
      expect(applyEdits(text, edits)).toBe(text);
   });

   test('single-line replacement (typical bounds change)', () => {
      const oldText = 'a:\n  x: 10\n  y: 20\n';
      const newText = 'a:\n  x: 15\n  y: 20\n';
      expect(roundTrip(oldText, newText)).toBe(newText);
   });

   test('multiple non-adjacent line changes', () => {
      const oldText = 'a\nb\nc\nd\ne\n';
      const newText = 'a\nB\nc\nD\ne\n';
      expect(roundTrip(oldText, newText)).toBe(newText);
   });

   test('pure insert at start', () => {
      expect(roundTrip('b\nc\n', 'a\nb\nc\n')).toBe('a\nb\nc\n');
   });

   test('pure insert in middle', () => {
      expect(roundTrip('a\nc\n', 'a\nb\nc\n')).toBe('a\nb\nc\n');
   });

   test('pure insert at end', () => {
      expect(roundTrip('a\nb\n', 'a\nb\nc\n')).toBe('a\nb\nc\n');
   });

   test('pure delete from start', () => {
      expect(roundTrip('a\nb\nc\n', 'b\nc\n')).toBe('b\nc\n');
   });

   test('pure delete from middle', () => {
      expect(roundTrip('a\nb\nc\n', 'a\nc\n')).toBe('a\nc\n');
   });

   test('pure delete from end', () => {
      expect(roundTrip('a\nb\nc\n', 'a\nb\n')).toBe('a\nb\n');
   });

   test('from empty to non-empty', () => {
      expect(roundTrip('', 'a\nb\n')).toBe('a\nb\n');
   });

   test('from non-empty to empty', () => {
      expect(roundTrip('a\nb\n', '')).toBe('');
   });

   test('no trailing newline (old) → add trailing newline', () => {
      expect(roundTrip('a\nb\nc', 'a\nb\nc\n')).toBe('a\nb\nc\n');
   });

   test('trailing newline (old) → remove trailing newline', () => {
      expect(roundTrip('a\nb\nc\n', 'a\nb\nc')).toBe('a\nb\nc');
   });

   test('no trailing newline on both + change last line', () => {
      expect(roundTrip('a\nb\nc', 'a\nb\nC')).toBe('a\nb\nC');
   });

   test('preserves leading whitespace', () => {
      const oldText = '  a:\n    x: 1\n    y: 2\n';
      const newText = '  a:\n    x: 99\n    y: 2\n';
      expect(roundTrip(oldText, newText)).toBe(newText);
   });

   test('CRLF line endings round-trip', () => {
      expect(roundTrip('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')).toBe('a\r\nB\r\nc\r\n');
   });

   test('mixed add + remove in different regions', () => {
      expect(roundTrip('a\nb\nc\nd\ne\n', 'a\nb-new\nc\ne\nf\n')).toBe('a\nb-new\nc\ne\nf\n');
   });

   test('replace a block with shorter block', () => {
      expect(roundTrip('a\nb\nc\nd\ne\n', 'a\nX\ne\n')).toBe('a\nX\ne\n');
   });

   test('replace a block with longer block', () => {
      expect(roundTrip('a\nX\ne\n', 'a\nb\nc\nd\ne\n')).toBe('a\nb\nc\nd\ne\n');
   });
});

const FULL_RANGE = Range.create(0, 0, uinteger.MAX_VALUE, uinteger.MAX_VALUE);

function isFullReplace(edits: TextEdit[], expectedText: string): boolean {
   return edits.length === 1 && edits[0].range.end.line === FULL_RANGE.end.line && edits[0].newText === expectedText;
}

describe('DefaultLanguageClientShadow.preparePush', () => {
   const KEY = 'file:///test.a' as CanonicalUri;
   const URI = asLanguageClientUri('file:///test.a');
   const editsOf = (shadow: DefaultLanguageClientShadow, text: string): TextEdit[] => shadow.preparePush(KEY, URI, text)?.edits ?? [];
   const fallbacks = (lines: CapturedLine[]): CapturedLine[] => lines.filter(line => /apply-verify fallback/.test(line.message));
   /** Opened with an equality-only snapshot, so the first push is a full replace. */
   const openShadow = (configuration = factories): ReturnType<typeof makeShadow> => {
      const made = makeShadow(configuration);
      made.shadow.addOpen(KEY, URI, 1, '', false);
      return made;
   };

   test('pushes to no URI until the client opens the key, then to that URI', () => {
      const { shadow } = makeShadow();
      expect(shadow.pushTargets(KEY)).toEqual([]);
      shadow.addOpen(KEY, URI, 1, '', true);
      expect(shadow.pushTargets(KEY)).toEqual([URI]);
   });

   test('first call emits a full-range replace', () => {
      const { shadow } = openShadow();
      expect(isFullReplace(editsOf(shadow, 'a\nb\n'), 'a\nb\n')).toBe(true);
   });

   test('identical follow-up plans nothing', () => {
      const { shadow } = openShadow();
      shadow.preparePush(KEY, URI, 'a\nb\n');
      expect(shadow.preparePush(KEY, URI, 'a\nb\n')).toBeUndefined();
   });

   test('subsequent change emits a diff (not full replace)', () => {
      const { shadow } = openShadow();
      shadow.preparePush(KEY, URI, 'a\nb\nc\n');
      const edits = editsOf(shadow, 'a\nB\nc\n');
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(isFullReplace(edits, 'a\nB\nc\n')).toBe(false);
   });

   test('invalidateClientText forces next call back to full-range replace', () => {
      const { shadow } = openShadow();
      shadow.preparePush(KEY, URI, 'a\nb\n');
      shadow.invalidateClientText(URI);
      expect(isFullReplace(editsOf(shadow, 'a\nB\n'), 'a\nB\n')).toBe(true);
   });

   test('a settled push ignores a second answer', () => {
      const { shadow } = openShadow();
      shadow.setClientText(URI, 'a\nb\n');
      const push = shadow.preparePush(KEY, URI, 'a\nB\n');
      push?.notifyOutcome('applied');
      // A refusal invalidates the baseline; counted, the next push would be a full replace.
      push?.notifyOutcome('refused');
      expect(isFullReplace(editsOf(shadow, 'a\nB\nc\n'), 'a\nB\nc\n')).toBe(false);
   });

   test('setClientText primes the baseline so next call is a diff', () => {
      const { shadow } = openShadow();
      shadow.setClientText(URI, 'a\nb\n');
      expect(isFullReplace(editsOf(shadow, 'a\nB\n'), 'a\nB\n')).toBe(false);
   });

   test('logs no fallback on the happy paths', () => {
      // Apply-verify failure cannot be triggered naturally, since diffToEdits
      // reconstructs `newText` exactly. This only pins that the log stays
      // silent on the happy paths; the injected-mismatch test drives the fallback.
      const { shadow, lines } = openShadow();
      shadow.preparePush(KEY, URI, 'a\nb\n');
      shadow.preparePush(KEY, URI, 'a\nB\n');
      expect(fallbacks(lines)).toEqual([]);
   });

   test('falls back to a full replace and warns when apply-verify mismatches', () => {
      // A `create` whose probe never holds the text it is asked for, so applying
      // the diff to it can never reproduce the pushed text. Kills the mismatch
      // guard, its warning and the `return [fullReplace]`.
      const corrupting: TextDocumentsConfiguration<TextDocument> = {
         ...factories,
         create: (uri, languageId, version) => TextDocument.create(uri, languageId, version, 'WRONG\n')
      };
      const { shadow, lines } = openShadow(corrupting);
      // Prime a baseline so the push takes the diff path (not the first-sync full replace).
      shadow.setClientText(URI, 'a\nb\nc\n');
      const edits = editsOf(shadow, 'a\nB\nc\n');
      expect(fallbacks(lines).map(line => line.level)).toEqual(['warn']);
      expect(isFullReplace(edits, 'a\nB\nc\n')).toBe(true);
   });
});
