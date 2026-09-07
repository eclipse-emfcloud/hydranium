/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, test } from 'vitest';
import { Range, type TextEdit, uinteger } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageClientTextShadow, diffToEdits } from '../../src/documents/language-client-text-shadow.js';

/**
 * Minimal `ShadowDocumentSource` stub for these tests — `computeEdits`'s
 * apply-verify probe is the only state-bearing path that reads from it,
 * and the default `TextDocument.create` factory is sufficient (these
 * tests don't exercise the custom-text-document-type story; that's
 * exercised end-to-end through the `HydraniumTextDocuments` integration
 * tests).
 */
const stubDocumentSource = { create: TextDocument.create };

function makeShadow(onFallback: (uri: string, reason: string) => void = () => undefined): LanguageClientTextShadow {
   return new LanguageClientTextShadow(onFallback, stubDocumentSource);
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

describe('LanguageClientTextShadow.computeEdits', () => {
   const URI = 'file:///test.a';

   test('first call emits a full-range replace', () => {
      const shadow = makeShadow();
      const edits = shadow.computeEdits(URI, 'a\nb\n');
      expect(isFullReplace(edits, 'a\nb\n')).toBe(true);
   });

   test('identical follow-up returns no edits', () => {
      const shadow = makeShadow();
      shadow.computeEdits(URI, 'a\nb\n');
      expect(shadow.computeEdits(URI, 'a\nb\n')).toEqual([]);
   });

   test('subsequent change emits a diff (not full replace)', () => {
      const shadow = makeShadow();
      shadow.computeEdits(URI, 'a\nb\nc\n');
      const edits = shadow.computeEdits(URI, 'a\nB\nc\n');
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(isFullReplace(edits, 'a\nB\nc\n')).toBe(false);
   });

   test('invalidate forces next call back to full-range replace', () => {
      const shadow = makeShadow();
      shadow.computeEdits(URI, 'a\nb\n');
      shadow.invalidate(URI);
      const edits = shadow.computeEdits(URI, 'a\nB\n');
      expect(isFullReplace(edits, 'a\nB\n')).toBe(true);
   });

   test('set primes the shadow so next call is a diff', () => {
      const shadow = makeShadow();
      shadow.set(URI, 'a\nb\n');
      const edits = shadow.computeEdits(URI, 'a\nB\n');
      expect(isFullReplace(edits, 'a\nB\n')).toBe(false);
   });

   test('onFallback wiring is plumbed (no fallback in happy paths)', () => {
      // Apply-verify failure cannot be triggered naturally, since diffToEdits
      // reconstructs `newText` exactly. This only pins that the callback stays
      // silent on the happy paths; the injected-mismatch test drives the fallback.
      const calls: Array<[string, string]> = [];
      const shadow = makeShadow((uri, reason) => calls.push([uri, reason]));
      shadow.computeEdits(URI, 'a\nb\n');
      shadow.computeEdits(URI, 'a\nB\n');
      expect(calls).toEqual([]);
   });

   test('falls back to a full replace and notifies when apply-verify mismatches', () => {
      // Inject a ShadowDocumentSource whose `create` returns a probe document
      // that does NOT reconstruct `newText` under the diff. This drives the
      // apply-verify safety net via the documented injection seam without
      // breaking diffToEdits. Kills the mismatch guard (`if (false)`), its
      // block, the onFallback reason string, and the `return [fullReplace]`
      // (`[]`).
      const calls: Array<[string, string]> = [];
      // The probe always materialises 'WRONG\n' whatever content it is asked
      // for, so applying the diff to it can never reproduce `newText` → the
      // verifier must report a mismatch.
      const corruptingSource = {
         create: (uri: string, languageId: string, version: number) => TextDocument.create(uri, languageId, version, 'WRONG\n')
      };
      const shadow = new LanguageClientTextShadow((uri, reason) => calls.push([uri, reason]), corruptingSource);
      // Prime a baseline so computeEdits takes the diff path (not the first-sync full replace).
      shadow.set(URI, 'a\nb\nc\n');
      const edits = shadow.computeEdits(URI, 'a\nB\nc\n');
      // Fallback fired with the apply-verify reason ...
      expect(calls).toEqual([[URI, 'apply-verify-mismatch']]);
      // ... and returned a single full-range replace carrying the whole new text.
      expect(isFullReplace(edits, 'a\nB\nc\n')).toBe(true);
   });
});
