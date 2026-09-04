/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { WorkspaceValidationResult } from '@hydranium/core/node';
import { describe, expect, it } from 'vitest';
import { formatValidationReport, validationExitCode } from '../src/commands/validate-report.js';

const CLEAN: WorkspaceValidationResult = {
   documents: 3,
   findings: [],
   counts: { error: 0, warning: 0, info: 0, hint: 0 }
};

const WITH_PROBLEMS: WorkspaceValidationResult = {
   documents: 2,
   findings: [
      { uri: 'a.a', severity: 'error', message: 'boom', line: 2, character: 4, code: 'no-boom' },
      { uri: 'a.a', severity: 'warning', message: 'careful', line: 0, character: 0 },
      { uri: 'b.a', severity: 'info', message: 'fyi', line: 1, character: 1 }
   ],
   counts: { error: 1, warning: 1, info: 1, hint: 0 }
};

describe('validationExitCode', () => {
   it('fails on any error regardless of strict', () => {
      expect(validationExitCode(WITH_PROBLEMS)).toBe(1);
      expect(validationExitCode(WITH_PROBLEMS, true)).toBe(1);
   });

   it('passes on warnings by default, fails on them under strict', () => {
      const warningsOnly: WorkspaceValidationResult = {
         documents: 1,
         findings: [{ uri: 'a.a', severity: 'warning', message: 'careful', line: 0, character: 0 }],
         counts: { error: 0, warning: 1, info: 0, hint: 0 }
      };
      expect(validationExitCode(warningsOnly)).toBe(0);
      expect(validationExitCode(warningsOnly, true)).toBe(1);
   });

   it('never fails on info/hint alone, even under strict', () => {
      const advisory: WorkspaceValidationResult = {
         documents: 1,
         findings: [],
         counts: { error: 0, warning: 0, info: 2, hint: 1 }
      };
      expect(validationExitCode(advisory, true)).toBe(0);
   });

   it('passes a clean workspace', () => {
      expect(validationExitCode(CLEAN, true)).toBe(0);
   });
});

describe('formatValidationReport', () => {
   it('reports the clean-workspace message with pluralised file count', () => {
      expect(formatValidationReport(CLEAN)).toBe('No problems found in 3 files.');
      expect(formatValidationReport({ ...CLEAN, documents: 1 })).toBe('No problems found in 1 file.');
   });

   it('groups findings by document with 1-based location, severity, message and code, then a summary', () => {
      expect(formatValidationReport(WITH_PROBLEMS)).toBe(
         [
            'a.a',
            '  3:5     error   boom  (no-boom)',
            '  1:1     warning careful',
            '',
            'b.a',
            '  2:2     info    fyi',
            '',
            '1 error, 1 warning, 1 info in 2 files.'
         ].join('\n')
      );
   });

   it('emits the raw result as pretty JSON under --json', () => {
      expect(formatValidationReport(WITH_PROBLEMS, { json: true })).toBe(JSON.stringify(WITH_PROBLEMS, undefined, 2));
   });
});
