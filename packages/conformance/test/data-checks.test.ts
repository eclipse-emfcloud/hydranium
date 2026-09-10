/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { TransferElement } from '@hydranium/protocol';
import { buildDataChecks, type DataConformanceDriver } from '../src/data/index.js';
import type { LanguageFixture } from '../src/model.js';

const fixture: LanguageFixture = {
   valid: { uri: 'file:///a.x', languageId: 'x', text: 'valid' },
   invalid: { uri: 'file:///b.x', languageId: 'x', text: 'invalid' },
   edit: { to: 'edited', expect: () => true },
   referenceQuery: { type: 'Source', property: 'target', folderUri: 'file:///folder', expectCandidate: 'Target' }
};

// Never invoked — these tests inspect the planned check list (titles, count,
// run-vs-skip), not the bodies (those are dogfooded against the real server).
const connect = (): DataConformanceDriver<TransferElement> => {
   throw new Error('connect must not be called when only inspecting the plan');
};

describe('buildDataChecks', () => {
   it('plans three server-level checks plus six grammar-bearing checks per language', () => {
      expect(buildDataChecks({ connect, languages: [fixture] })).toHaveLength(9);
      expect(buildDataChecks({ connect, languages: [fixture, fixture] })).toHaveLength(15);
   });

   it('runs every data check when the fixture supplies an edit and the options expect projects', () => {
      const checks = buildDataChecks({ connect, languages: [fixture], expectsProjects: true });
      expect(checks.every(check => typeof check.body === 'function')).toBe(true);
   });

   it('plans the same checks without an edit, but skips the two that need one', () => {
      // The checks are still PLANNED — reported as skipped with a reason —
      // rather than silently absent, which is what distinguishes an opt-out
      // from lost coverage.
      const { edit: _edit, ...withoutEdit } = fixture;
      const checks = buildDataChecks({ connect, languages: [withoutEdit], expectsProjects: true });

      expect(checks).toHaveLength(9);
      const skipped = checks.filter(check => check.body === undefined);
      expect(skipped.map(check => check.title)).toEqual([
         expect.stringContaining('updateModelDocument applies an edit'),
         expect.stringContaining('subscribe + update delivers an onDocumentUpdated event')
      ]);
      expect(skipped.every(check => (check.skipReason ?? '').includes('`edit`'))).toBe(true);
   });

   it('plans the reference query but skips it, with a named reason, without a referenceQuery', () => {
      // Same contract as `edit`: a language with no create-element dialog opts
      // out, and the check reports skipped rather than being absent — so an
      // opt-out stays distinguishable from lost coverage.
      const { referenceQuery: _query, ...withoutQuery } = fixture;
      const checks = buildDataChecks({ connect, languages: [withoutQuery], expectsProjects: true });

      expect(checks).toHaveLength(9);
      const skipped = checks.filter(check => check.body === undefined);
      expect(skipped.map(check => check.title)).toEqual([
         expect.stringContaining('findReferenceCandidates answers for a synthetic source')
      ]);
      expect(skipped[0].skipReason).toContain('`referenceQuery`');
   });

   it('skips the project-emptiness check, with a named reason, when the options do not expect projects', () => {
      // `[]` is the documented answer for a head with no project tier, so the
      // emptiness claim is the adopter's to make. Without it the check must
      // report SKIPPED — passing vacuously is the defect this guards.
      const checks = buildDataChecks({ connect, languages: [fixture] });
      const skipped = checks.filter(check => check.body === undefined);

      expect(skipped.map(check => check.title)).toEqual([expect.stringContaining('getProjects answers at least one project')]);
      expect(skipped[0].skipReason).toContain('`expectsProjects`');
   });

   it('leaves the checks that do not need an edit runnable without one', () => {
      const { edit: _edit, ...withoutEdit } = fixture;
      const runnable = buildDataChecks({ connect, languages: [withoutEdit], expectsProjects: true }).filter(
         check => typeof check.body === 'function'
      );
      // getProjects shape, getProjects non-empty and waitForReady separately,
      // plus valid-envelope, invalid-diagnostics, the diagnostic-params check
      // and the folder-URI reference query — none of which needs an edit.
      expect(runnable).toHaveLength(7);
   });

   it('includes each server-level check exactly once regardless of the language count', () => {
      const serverLevel = buildDataChecks({ connect, languages: [fixture, fixture], expectsProjects: true }).filter(check =>
         check.title.includes('getProjects')
      );
      expect(serverLevel.map(check => check.title)).toEqual([
         'getProjects answers an array of well-formed projects',
         'getProjects answers at least one project (projects expected)'
      ]);
   });
});
