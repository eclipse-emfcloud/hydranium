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
import type { WorkspaceValidationResult } from '@hydranium/core/node';

/** `s` when `count !== 1`, else empty. */
function plural(count: number): string {
   return count === 1 ? '' : 's';
}

/** `<n> file` / `<n> files`. */
function fileCount(documents: number): string {
   return `${documents} file${plural(documents)}`;
}

/**
 * The exit code for a validation run: non-zero blocks the CI gate.
 * Errors always fail; `strict` additionally fails on warnings. Info/hint
 * findings are advisory and never affect the exit code.
 */
export function validationExitCode(result: WorkspaceValidationResult, strict = false): number {
   if (result.counts.error > 0) {
      return 1;
   }
   if (strict && result.counts.warning > 0) {
      return 1;
   }
   return 0;
}

/** One-line severity tally over the file count, or the clean-workspace message. */
function summaryLine(result: WorkspaceValidationResult): string {
   const { error, warning, info, hint } = result.counts;
   if (error + warning + info + hint === 0) {
      return `No problems found in ${fileCount(result.documents)}.`;
   }
   const parts: string[] = [];
   if (error) {
      parts.push(`${error} error${plural(error)}`);
   }
   if (warning) {
      parts.push(`${warning} warning${plural(warning)}`);
   }
   if (info) {
      parts.push(`${info} info`);
   }
   if (hint) {
      parts.push(`${hint} hint${plural(hint)}`);
   }
   return `${parts.join(', ')} in ${fileCount(result.documents)}.`;
}

/**
 * Render a validation result for the terminal. `json` emits the raw
 * {@link WorkspaceValidationResult} (the machine-readable CI contract); the
 * default is a human report that groups findings by document — one header per
 * file followed by `line:col  severity  message  (code)` lines — and closes
 * with the {@link summaryLine} tally.
 *
 * Findings arrive already grouped contiguously by document (the framework
 * collector iterates per document), so a header is emitted whenever the URI
 * changes rather than pre-bucketing.
 */
export function formatValidationReport(result: WorkspaceValidationResult, options: { json?: boolean } = {}): string {
   if (options.json) {
      return JSON.stringify(result, undefined, 2);
   }
   const lines: string[] = [];
   let currentUri: string | undefined;
   for (const finding of result.findings) {
      if (finding.uri !== currentUri) {
         if (currentUri !== undefined) {
            lines.push('');
         }
         lines.push(finding.uri);
         currentUri = finding.uri;
      }
      const location = `${finding.line + 1}:${finding.character + 1}`;
      const code = finding.code !== undefined ? `  (${finding.code})` : '';
      lines.push(`  ${location.padEnd(7)} ${finding.severity.padEnd(7)} ${finding.message}${code}`);
   }
   if (result.findings.length > 0) {
      lines.push('');
   }
   lines.push(summaryLine(result));
   return lines.join('\n');
}
