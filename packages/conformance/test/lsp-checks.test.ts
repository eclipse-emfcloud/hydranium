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

   it('runs both render checks when the fixture names a locale and both fragments', () => {
      const fixture: LanguageFixture = {
         ...base,
         renderedDiagnostic: { locale: 'xx-AA', expected: 'AA:', absentWithLocale: 'Could not' }
      };
      const planned = buildLspChecks({ connect, languages: [fixture] });

      expect(planned.find(check => check.title.includes('rendered in the locale'))?.body).toBeDefined();
      expect(planned.find(check => check.title.includes('NOT rendered'))?.body).toBeDefined();
   });

   it('runs the render check but SKIPS its control when absentWithLocale is omitted', () => {
      // The weaker configuration, reported rather than silently accepted: a
      // containment check alone passes for a server whose English happens to
      // contain the fragment, so a reader has to be able to see from the report
      // that the discriminating half did not run.
      const fixture: LanguageFixture = { ...base, renderedDiagnostic: { locale: 'xx-AA', expected: 'AA:' } };
      const planned = buildLspChecks({ connect, languages: [fixture] });

      expect(planned.find(check => check.title.includes('rendered in the locale'))?.body).toBeDefined();
      const control = planned.find(check => check.title.includes('NOT rendered'));
      expect(control?.body).toBeUndefined();
      expect(control?.skipReason).toBe('fixture supplied no absentWithLocale, so the render check is a containment test only');
   });

   it('skips both render checks with a named reason when the fixture does not opt in', () => {
      // The framework ships no catalogue and selects no locale, so a server that
      // renders nothing is CORRECT — mandating this would fail every adopter
      // without i18n for doing the right thing.
      const planned = buildLspChecks({ connect, languages: [base] });

      for (const title of ['rendered in the locale', 'NOT rendered']) {
         const check = planned.find(candidate => candidate.title.includes(title));
         expect(check?.body).toBeUndefined();
         expect(check?.skipReason).toBe('fixture supplied no renderedDiagnostic (server-side rendering is opt-in)');
      }
   });

   it('plans three server-level checks plus six grammar-bearing checks per language', () => {
      // textDocumentSync + completionProvider + shutdown (once) + 6 per language
      // (didOpen valid/invalid, didChange, completion, render, render control).
      expect(buildLspChecks({ connect, languages: [base] })).toHaveLength(9);
      expect(buildLspChecks({ connect, languages: [base, base] })).toHaveLength(15);
   });
});
