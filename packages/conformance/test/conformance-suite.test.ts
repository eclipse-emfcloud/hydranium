/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
   emitConformanceSuite,
   formatSummary,
   skippedTitle,
   summarizeChecks,
   writeConformanceSummary,
   type ConformanceCheck,
   type ConformanceRunner
} from '../src/conformance-suite.js';

describe('summarizeChecks', () => {
   it('counts a check with a body as ran and one without a body as skipped', () => {
      const checks: ConformanceCheck[] = [
         { title: 'has a body', body: () => undefined },
         { title: 'no body', skipReason: 'needs completionPosition' }
      ];

      const summary = summarizeChecks(checks);

      expect(summary.total).toBe(2);
      expect(summary.ran).toBe(1);
      expect(summary.skipped).toEqual([{ title: 'no body', reason: 'needs completionPosition' }]);
   });

   it('defaults a missing skip reason to a placeholder rather than undefined', () => {
      const summary = summarizeChecks([{ title: 'opaque skip' }]);

      expect(summary.ran).toBe(0);
      expect(summary.skipped).toEqual([{ title: 'opaque skip', reason: 'no reason given' }]);
   });
});

describe('skippedTitle', () => {
   it('annotates the check title with its skip reason so the test report shows why', () => {
      expect(skippedTitle({ title: 'completion', skipReason: 'no completionPosition' })).toBe(
         'completion [skipped: no completionPosition]'
      );
   });

   it('falls back to a placeholder reason when none was given', () => {
      expect(skippedTitle({ title: 'mystery' })).toBe('mystery [skipped: no reason given]');
   });
});

describe('formatSummary', () => {
   it('names the suite and reports the ran-vs-skipped counts with each skipped reason', () => {
      const text = formatSummary('conformance: data-server', {
         total: 3,
         ran: 2,
         skipped: [{ title: 'subscription echo', reason: 'opt-in' }]
      });

      expect(text).toContain('conformance: data-server');
      expect(text).toContain('2/3 ran');
      expect(text).toContain('1 skipped');
      expect(text).toContain('subscription echo');
      expect(text).toContain('opt-in');
   });

   it('omits the skipped list when nothing was skipped', () => {
      const text = formatSummary('conformance: lsp', { total: 4, ran: 4, skipped: [] });

      expect(text).toContain('4/4 ran');
      expect(text).not.toMatch(/skipped:/i);
   });
});

describe('writeConformanceSummary', () => {
   afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
   });

   it('writes the summary to process.stderr, the sink a test runner does not attribute to a task', () => {
      // The kit's only false-green guard is the summary reaching the output at
      // all. vitest attributes console output to the running task and an
      // `afterAll` hook has none, so a `console.log` here is dropped silently
      // and a half-implemented adopter reads as a clean pass.
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const log = vi.spyOn(console, 'log').mockReturnValue(undefined);

      writeConformanceSummary('conformance: demo: 1/2 ran, 1 skipped');

      expect(stderr).toHaveBeenCalledExactlyOnceWith('conformance: demo: 1/2 ran, 1 skipped\n');
      expect(log).not.toHaveBeenCalled();
   });

   it('falls back to console.log where there is no process, so the neutral entry does not assume Node', () => {
      const log = vi.spyOn(console, 'log').mockReturnValue(undefined);
      vi.stubGlobal('process', undefined);

      writeConformanceSummary('conformance: demo: 4/4 ran, 0 skipped');

      expect(log).toHaveBeenCalledExactlyOnceWith('conformance: demo: 4/4 ran, 0 skipped');
   });
});

describe('emitConformanceSuite', () => {
   it('emits each bodied check as a test and each bodiless one as a skip, under one describe with an afterAll', () => {
      const tests: string[] = [];
      const skips: string[] = [];
      let describedSuite: string | undefined;
      let afterAllRegistered = false;
      // A structural runner double that records what the emit layer registers,
      // and invokes the describe callback so the nested test/skip calls run.
      const runner: ConformanceRunner = {
         describe(name, register): void {
            describedSuite = name;
            register();
         },
         test(name): void {
            tests.push(name);
         },
         skip(name): void {
            skips.push(name);
         },
         afterAll(): void {
            afterAllRegistered = true;
         }
      };

      emitConformanceSuite(runner, 'conformance: demo', [
         { title: 'runs', body: () => undefined },
         { title: 'absent', skipReason: 'no fixture' }
      ]);

      expect(describedSuite).toBe('conformance: demo');
      expect(tests).toEqual(['runs']);
      expect(skips).toEqual(['absent [skipped: no fixture]']);
      expect(afterAllRegistered).toBe(true);
   });
});
