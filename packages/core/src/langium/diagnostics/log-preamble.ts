/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DEFER_START_MS, type Logger } from '@hydranium/protocol';

const DIVIDER = '───────────────────────────────────────────────────────────────────';

export interface LogPreambleOptions {
   /** Product name shown in the session header. */
   productName: string;
   /** Resolved product version. */
   version: string;
   /**
    * Threshold (ms) above which the framework emits per-phase rebuild detail in
    * its document builder. Used in the format-conventions section so log readers
    * know which timings expand into sub-phases. Defaults to 50.
    */
   phaseDetailThresholdMs?: number;
   /**
    * Extra session-info lines appended to the header block (e.g. Node
    * runtime / platform / pid / heap-limit / host). Empty on portable hosts;
    * `@hydranium/core/node`'s `nodeSystemInfoLines()` supplies them on Node.
    */
   systemInfoLines?: readonly string[];
   /**
    * Extra format-convention lines appended to the conventions block (e.g. the
    * Node-only `[EventLoop]` / `[Memory]` monitor + memory-suffix behaviour).
    * Empty on portable hosts; `@hydranium/core/node`'s `nodeConventionLines()`
    * supplies them on Node.
    */
   conventionLines?: readonly string[];
}

/**
 * Emits session info and log format conventions. The body is portable
 * (browser-safe); Node-specific runtime details and monitor conventions are
 * injected via {@link LogPreambleOptions.systemInfoLines} /
 * {@link LogPreambleOptions.conventionLines} (see `@hydranium/core/node`).
 */
export function logPreamble(logger: Logger, options: LogPreambleOptions): void {
   logSessionInfo(logger, options.productName, options.version, options.systemInfoLines ?? []);
   logFormatConventions(logger, options.phaseDetailThresholdMs ?? 50, options.conventionLines ?? []);
}

function logSessionInfo(logger: Logger, productName: string, version: string, systemInfoLines: readonly string[]): void {
   const now = new Date();
   const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD, unambiguous across midnight
   const lines = [
      DIVIDER,
      `${productName} server session`,
      DIVIDER,
      `date        ${dateStr}`,
      `version     ${version}`,
      ...systemInfoLines,
      DIVIDER
   ];
   for (const line of lines) {
      logger.info(line);
   }
}

function logFormatConventions(logger: Logger, phaseDetailThresholdMs: number, conventionLines: readonly string[]): void {
   const lines = [
      'Log format conventions',
      DIVIDER,
      '• Timing pairs:   "<op> [#N start]"  ->  "<op> [#N done|cancelled|failed, Nms]"',
      '• Rebuild tags:   contextual metadata lives inside the status brackets, e.g.',
      '                  "[#N start, event: didChangeContent, cancels #M]"',
      `• Quiet ops:      operations under ${DEFER_START_MS}ms are silent; lifecycle ops (save, load) always log`,
      '                  (failures/cancels always log, even below the threshold - in that case',
      '                  [start] is emitted retroactively so timestamps may be back-to-back while',
      '                  the reported Nms is the real elapsed time)',
      `• Phase detail:   Parsed/IndexedContent/.../Validated shown only for rebuilds >=${phaseDetailThresholdMs}ms;`,
      '                  workspace init always emits per-phase lines live',
      ...conventionLines,
      DIVIDER
   ];
   for (const line of lines) {
      logger.info(line);
   }
}
