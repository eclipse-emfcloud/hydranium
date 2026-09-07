/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildLspChecks, type LspConformanceDriver } from '../src/lsp/index.js';
import type { LanguageFixture } from '../src/model.js';

const base: LanguageFixture = {
   valid: { uri: 'file:///a.x', languageId: 'x', text: 'valid' },
   invalid: { uri: 'file:///b.x', languageId: 'x', text: 'invalid' },
   edit: { to: 'edited', expect: () => true }
};

// Never invoked — these tests inspect the planned check list, not the bodies.
const connect = (): LspConformanceDriver => {
   throw new Error('connect must not be called when only inspecting the plan');
};

describe('buildLspChecks', () => {
   it('runs the completion check when the fixture supplies a completionPosition', () => {
      const fixture: LanguageFixture = { ...base, completionPosition: { line: 0, character: 0 } };
      const completion = buildLspChecks({ connect, languages: [fixture] }).find(check => check.title.includes('well-formed item list'));
      expect(completion?.body).toBeDefined();
      expect(completion?.skipReason).toBeUndefined();
   });

   it('skips the completion check with a named reason when no completionPosition is supplied', () => {
      const completion = buildLspChecks({ connect, languages: [base] }).find(check => check.title.includes('well-formed item list'));
      expect(completion?.body).toBeUndefined();
      expect(completion?.skipReason).toBe('fixture supplied no completionPosition');
   });

   it('asserts the completionProvider baseline only when a fixture opts into completion', () => {
      const fixture: LanguageFixture = { ...base, completionPosition: { line: 0, character: 0 } };
      const baseline = buildLspChecks({ connect, languages: [fixture] }).find(check => check.title.includes('completionProvider'));
      expect(baseline?.body).toBeDefined();
      expect(baseline?.skipReason).toBeUndefined();
   });

   it('skips the completionProvider baseline with a named reason when no fixture opts in', () => {
      const baseline = buildLspChecks({ connect, languages: [base] }).find(check => check.title.includes('completionProvider'));
      expect(baseline?.body).toBeUndefined();
      expect(baseline?.skipReason).toBe('no fixture supplied a completionPosition (completion is opt-in)');
   });

   it('plans three server-level checks plus four grammar-bearing checks per language', () => {
      // textDocumentSync + completionProvider + shutdown (once) + 4 per language
      // (didOpen valid/invalid, didChange, completion).
      expect(buildLspChecks({ connect, languages: [base] })).toHaveLength(7);
      expect(buildLspChecks({ connect, languages: [base, base] })).toHaveLength(11);
   });
});
