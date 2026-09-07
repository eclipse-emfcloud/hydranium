/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * One conformance check. A check with a {@link body} is RUN (emitted as a
 * runner test); a check WITHOUT a body is SKIPPED — its optional fixture input
 * was absent, so it reports as skipped with a named {@link skipReason} rather
 * than passing vacuously. The false-green guard (require both a valid and an
 * invalid model) lives in the slices; this type is the head-agnostic unit they
 * build.
 */
export interface ConformanceCheck {
   readonly title: string;
   /** Present ⇒ the check runs. Absent ⇒ the check is skipped with {@link skipReason}. */
   readonly body?: () => void | Promise<void>;
   /** Why the check was skipped — surfaced in the `it.skip` title and the summary. */
   readonly skipReason?: string;
}

/** A single skipped check in a {@link ConformanceSummary}. */
export interface SkippedCheck {
   readonly title: string;
   readonly reason: string;
}

/** Ran-vs-skipped tally over a battery of {@link ConformanceCheck}s. */
export interface ConformanceSummary {
   readonly total: number;
   readonly ran: number;
   readonly skipped: ReadonlyArray<SkippedCheck>;
}

/** Placeholder reason for a skipped check that supplied none. */
const NO_REASON = 'no reason given';

/**
 * Tally a battery of checks into ran-vs-skipped counts. A check is RAN when
 * it carries a {@link ConformanceCheck.body}; otherwise it is SKIPPED and its
 * (possibly defaulted) reason is collected.
 */
export function summarizeChecks(checks: ReadonlyArray<ConformanceCheck>): ConformanceSummary {
   const skipped: SkippedCheck[] = [];
   let ran = 0;
   for (const check of checks) {
      if (check.body) {
         ran++;
      } else {
         skipped.push({ title: check.title, reason: check.skipReason ?? NO_REASON });
      }
   }
   return { total: checks.length, ran, skipped };
}

/**
 * The `it.skip` title for a skipped check — the check title annotated with
 * its (possibly defaulted) reason, so the runner's report explains the skip
 * inline instead of showing a bare greyed-out line.
 */
export function skippedTitle(check: Pick<ConformanceCheck, 'title' | 'skipReason'>): string {
   return `${check.title} [skipped: ${check.skipReason ?? NO_REASON}]`;
}

/**
 * Render a one-or-more-line human summary of a {@link ConformanceSummary},
 * prefixed by the suite name. Printed once per suite so a half-implemented
 * adopter reads as *skipped*, never as a silent false green.
 */
export function formatSummary(suite: string, summary: ConformanceSummary): string {
   const header = `${suite}: ${summary.ran}/${summary.total} ran, ${summary.skipped.length} skipped`;
   if (summary.skipped.length === 0) {
      return header;
   }
   const lines = summary.skipped.map(skip => `  - skipped: ${skip.title} (${skip.reason})`);
   return [header, ...lines].join('\n');
}

/**
 * Write the ran-vs-skipped summary somewhere a test runner does not swallow.
 *
 * `console.log` is NOT that place: vitest attributes console output to the
 * running task, and an `afterAll` hook has none, so the line is dropped with no
 * warning — measured, not inferred. That silently disables the kit's only
 * false-green guard: a half-implemented adopter is supposed to read as
 * *skipped*, and with the summary gone it reads as a clean pass.
 *
 * `process.stderr` bypasses the interception. A runner with no `process` (a
 * browser runner) falls back to `console.log`, where nothing is intercepting in
 * the first place — the kit's `.` entry is neutrality-gated, so this must not
 * assume Node.
 */
export function writeConformanceSummary(text: string): void {
   const stderr = (globalThis as { process?: { stderr?: { write?(chunk: string): unknown } } }).process?.stderr;
   if (typeof stderr?.write === 'function') {
      stderr.write(`${text}\n`);
      return;
   }
   console.log(text);
}

/**
 * The minimal test-runner surface {@link emitConformanceSuite} drives, so the
 * kit core names NO concrete runner (`@jest/globals` / `vitest` / `node:test`)
 * and stays runner-agnostic. A thin per-runner adapter subpath
 * (`@hydranium/conformance/jest`, `@hydranium/conformance/vitest`) binds these
 * methods to its runner's `describe` / `it` / `it.skip` / `afterAll`.
 * Structural by design — jest and vitest both satisfy it directly.
 */
export interface ConformanceRunner {
   /** Group the suite's checks under `name`; `register` queues them (called synchronously). */
   describe(name: string, register: () => void): void;
   /** Register a running check. */
   test(name: string, body: () => void | Promise<void>): void;
   /** Register a skipped check (greyed out, never executed). */
   skip(name: string): void;
   /** Register a once-per-suite teardown — used to print the ran-vs-skipped summary. */
   afterAll(fn: () => void | Promise<void>): void;
}

/**
 * Emit a battery of {@link ConformanceCheck}s through an injected
 * {@link ConformanceRunner} — each check with a body becomes a `test`, each
 * without becomes a `skip` carrying its {@link skippedTitle}, and an `afterAll`
 * prints the {@link formatSummary} so the suite always reports ran-vs-skipped.
 * The thin, runner-agnostic translation layer between a slice's planned checks
 * (whose ran/skip decisions are the tested pure logic above) and a runner; a
 * per-runner adapter's `runXxxConformance` builds the check list and hands it
 * here with the runner bound.
 */
export function emitConformanceSuite(runner: ConformanceRunner, suite: string, checks: ReadonlyArray<ConformanceCheck>): void {
   runner.describe(suite, () => {
      for (const check of checks) {
         if (check.body) {
            runner.test(check.title, check.body);
         } else {
            runner.skip(skippedTitle(check));
         }
      }
      runner.afterAll(() => {
         writeConformanceSummary(formatSummary(suite, summarizeChecks(checks)));
      });
   });
}
