/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ProfileCaptureOptions } from '@hydranium/core/node';
import { fileURLToPath } from 'node:url';
import { runDriverChild, type DriverSpawnOptions } from './headless-harness.js';

/**
 * Absolute path to the spawned driver. From `lib/commands/measure-memory.js`
 * the compiled driver sits beside it at `lib/commands/measure-memory-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./measure-memory-driver.js', import.meta.url));

/** Options for the {@link runMeasureMemory} subcommand. */
export interface MeasureMemoryCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Workspace root (filesystem path or file URI) to build. */
   readonly workspace: string;
   /** Rebuild-churn cycles to probe for retention (default 0 = skip). */
   readonly editCycles?: number;
   /** Documents to churn per cycle. */
   readonly editDocs?: number;
   /** Only churn documents whose URI path ends with this suffix. */
   readonly churnSuffix?: string;
   /**
    * Wait this many milliseconds after the build before measuring, so a
    * timer-driven residency policy (`CstResidencyService`'s
    * `shed-closed-when-idle`) sheds before the reading is taken. Pass a value
    * comfortably above the policy's `idleMs`; omit (or `0`) to measure the
    * pre-shed heap (the always-keep-equivalent baseline).
    */
   readonly settleMs?: number;
   /** Write a `.heapsnapshot` after the build. */
   readonly writeSnapshot?: boolean;
   /** Snapshot path (default `<cwd>/<workspace-basename>.heapsnapshot`). */
   readonly snapshotPath?: string;
   /** Comma-separated profile dimensions to capture; see {@link parseProfileDimensions} for the tokens. */
   readonly profile?: string;
   /** Parent directory for the profiling session folder. Only used with {@link profile}. */
   readonly sessionOut?: string;
   /**
    * Emit the `MeasureModelMemoryResult` as JSON instead of the progress lines.
    *
    * The progress lines are suppressed rather than kept alongside it, because the
    * flag exists so a script can read stdout as one document — a preamble on the
    * same stream would leave every caller stripping it by hand.
    */
   readonly json?: boolean;
}

/**
 * Parse a `--profile` dimension list (`cpu,alloc,gc,eld,heap`) into
 * {@link ProfileCaptureOptions}. Case- and whitespace-tolerant; throws on an
 * unknown token so a typo fails loud rather than silently capturing nothing.
 */
export function parseProfileDimensions(csv: string): ProfileCaptureOptions {
   const options: ProfileCaptureOptions = {};
   for (const raw of csv.split(',')) {
      const token = raw.trim().toLowerCase();
      if (!token) {
         continue;
      }
      switch (token) {
         case 'cpu':
            options.cpu = true;
            break;
         case 'alloc':
         case 'allocation':
            options.allocation = true;
            break;
         case 'gc':
            options.gc = true;
            break;
         case 'eld':
         case 'eventloop':
         case 'event-loop':
            options.eventLoopDelay = true;
            break;
         case 'heap':
         case 'heapsnapshot':
            options.heapSnapshot = true;
            break;
         default:
            throw new Error(`Unknown profile dimension: ${token} (expected cpu, alloc, gc, eld, heap)`);
      }
   }
   return options;
}

/**
 * Build the argv the driver child parses. Pure → unit-testable; mirrors the
 * driver's own option names.
 */
export function buildDriverArgs(options: MeasureMemoryCommandOptions): string[] {
   const args = ['--services', options.servicesModule, options.workspace];
   if (options.editCycles !== undefined) {
      args.push('--edits', String(options.editCycles));
   }
   if (options.editDocs !== undefined) {
      args.push('--edit-docs', String(options.editDocs));
   }
   if (options.churnSuffix !== undefined) {
      args.push('--churn-suffix', options.churnSuffix);
   }
   if (options.settleMs !== undefined) {
      args.push('--settle', String(options.settleMs));
   }
   if (options.writeSnapshot) {
      args.push('--snapshot');
   }
   if (options.snapshotPath !== undefined) {
      args.push('--snapshot-path', options.snapshotPath);
   }
   if (options.profile !== undefined) {
      args.push('--profile', options.profile);
   }
   if (options.sessionOut !== undefined) {
      args.push('--session-out', options.sessionOut);
   }
   if (options.json) {
      args.push('--json');
   }
   return args;
}

/**
 * Headless model-store memory measurement. `hydranium-cli` is language-agnostic
 * and cannot import a head's `create<Lang>Services`, so the head passes a module
 * that exports a zero-arg `createServices` thunk (`--services`). Because the
 * underlying `measureModelMemory` harness needs post-GC readings, the work runs
 * in a spawned child launched with `--expose-gc`; the driver dynamic-imports the
 * module and reports the baseline / after-build / churn lines on stdout.
 */
export function runMeasureMemory(options: MeasureMemoryCommandOptions): Promise<void> {
   return runDriverChild(['--expose-gc', '--max-old-space-size=8192', DRIVER, ...buildDriverArgs(options)], options);
}
