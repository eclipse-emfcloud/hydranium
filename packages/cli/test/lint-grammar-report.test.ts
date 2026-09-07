/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { GrammarLintResult } from '@hydranium/core/node';
import { describe, expect, it } from 'vitest';
import { formatLintReport, lintExitCode } from '../src/commands/lint-grammar-report.js';

const CLEAN: GrammarLintResult = {
   findings: [],
   counts: { error: 0, warning: 0 },
   checkedReferenceTargets: 3,
   nameProperties: ['name']
};

const WITH_ERROR: GrammarLintResult = {
   findings: [
      {
         rule: 'reference-target-unnameable',
         severity: 'error',
         message:
            "Type 'TypeOne' is a cross-reference target but carries no name property (expected one of: id); references to it cannot resolve.",
         type: 'TypeOne'
      }
   ],
   counts: { error: 1, warning: 0 },
   checkedReferenceTargets: 1,
   nameProperties: ['id']
};

const WITH_WARNING: GrammarLintResult = {
   findings: [{ rule: 'demo-warning', severity: 'warning', message: 'heads up' }],
   counts: { error: 0, warning: 1 },
   checkedReferenceTargets: 0,
   nameProperties: ['name']
};

describe('lintExitCode', () => {
   it('fails on any error regardless of strict', () => {
      expect(lintExitCode(WITH_ERROR)).toBe(1);
      expect(lintExitCode(WITH_ERROR, true)).toBe(1);
   });

   it('passes on warnings by default, fails on them under strict', () => {
      expect(lintExitCode(WITH_WARNING)).toBe(0);
      expect(lintExitCode(WITH_WARNING, true)).toBe(1);
   });

   it('passes a clean result', () => {
      expect(lintExitCode(CLEAN)).toBe(0);
   });
});

describe('formatLintReport', () => {
   it('json: emits the raw result', () => {
      expect(JSON.parse(formatLintReport(WITH_ERROR, { json: true }))).toEqual(WITH_ERROR);
   });

   it('human: a clean run reports the checked-target count', () => {
      expect(formatLintReport(CLEAN)).toBe('No grammar-convention problems found (3 reference target types checked).');
   });

   it('human: a finding renders severity, rule, and message, then the tally', () => {
      const output = formatLintReport(WITH_ERROR);
      expect(output).toContain('error   [reference-target-unnameable]');
      expect(output).toContain("Type 'TypeOne' is a cross-reference target");
      expect(output.trim().endsWith('1 error.')).toBe(true);
   });
});
