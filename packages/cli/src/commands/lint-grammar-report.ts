/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Type-only import: the CLI is head-neutral and carries no runtime `@hydranium/core`
// dependency (the head's copy is resolved at run time via `loadHeadlessContext`).
import type { GrammarLintResult } from '@hydranium/core/node';

/** `s` when `count !== 1`, else empty. */
function plural(count: number): string {
   return count === 1 ? '' : 's';
}

/**
 * The exit code for a lint run: non-zero blocks the CI gate. Errors always fail;
 * `strict` additionally fails on warnings.
 */
export function lintExitCode(result: GrammarLintResult, strict = false): number {
   if (result.counts.error > 0) {
      return 1;
   }
   if (strict && result.counts.warning > 0) {
      return 1;
   }
   return 0;
}

/** One-line severity tally, or the clean-grammar message. */
function summaryLine(result: GrammarLintResult): string {
   const { error, warning } = result.counts;
   if (error + warning === 0) {
      // "target type", not "target": the tally counts distinct TYPES reachable
      // as a cross-reference target, not cross-reference properties. Several
      // references can share one target type, so the bare word reads as though
      // the lint had missed the rest.
      return `No grammar-convention problems found (${result.checkedReferenceTargets} reference target type${plural(
         result.checkedReferenceTargets
      )} checked).`;
   }
   const parts: string[] = [];
   if (error) {
      parts.push(`${error} error${plural(error)}`);
   }
   if (warning) {
      parts.push(`${warning} warning${plural(warning)}`);
   }
   return `${parts.join(', ')}.`;
}

/**
 * Render a grammar-convention lint result for the terminal. `json` emits the raw
 * {@link GrammarLintResult} (the machine-readable CI contract); the default is a
 * human report — one `severity  [rule]  message` line per finding — closing with
 * the {@link summaryLine} tally.
 */
export function formatLintReport(result: GrammarLintResult, options: { json?: boolean } = {}): string {
   if (options.json) {
      return JSON.stringify(result, undefined, 2);
   }
   const lines: string[] = [];
   for (const finding of result.findings) {
      lines.push(`  ${finding.severity.padEnd(7)} [${finding.rule}] ${finding.message}`);
   }
   if (result.findings.length > 0) {
      lines.push('');
   }
   lines.push(summaryLine(result));
   return lines.join('\n');
}
