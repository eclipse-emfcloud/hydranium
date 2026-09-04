/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   exitWithUsage,
   helpRequested,
   LOG_LEVEL_FLAG,
   logLevelHelpLine,
   logLevelOption,
   numericOption,
   parseHarnessArgs,
   printHelp,
   SERVICES_FLAG,
   type UsageError
} from './harness-args.js';
import { parseProfileDimensions, runMeasureMemory, type MeasureMemoryCommandOptions } from './measure-memory.js';

const VALUE_FLAGS = [
   '--edits',
   '--edit-docs',
   '--churn-suffix',
   '--settle',
   '--snapshot-path',
   '--profile',
   '--session-out',
   LOG_LEVEL_FLAG
] as const;
const BOOL_FLAGS = ['--snapshot', '--json'] as const;

/**
 * Every flag `measure-memory` accepts, derived from the sets the parser is
 * handed so the list cannot claim a flag the parser would reject. `--services`
 * is consumed by the shared harness parser itself, so it is in neither set.
 */
export const MEASURE_MEMORY_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS, ...BOOL_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const MEASURE_MEMORY_VALUE_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS];

/** The `--help` text, as data, held to {@link MEASURE_MEMORY_FLAGS} by a test. */
export const MEASURE_MEMORY_HELP: readonly string[] = [
   'Usage: hydranium-cli measure-memory --services <module> <workspace> [options]',
   '',
   'Measure model-store memory for a workspace. `<module>` is an ESM module that',
   'exports a zero-arg `createServices(): { shared }` thunk (the head wires its own',
   'filesystem inside). Runs in a `--expose-gc` child for post-GC readings; the',
   'baseline / after-build / churn lines print on stdout. Needs @hydranium/core.',
   '',
   'Options:',
   '  --services <module>   ESM module exporting `createServices(): { shared }` (required).',
   '  <workspace>           Workspace root (path or file URI) to build (required).',
   '  --edits <N>           Rebuild-churn cycles to probe for retention. Default: 0 (skip).',
   '  --edit-docs <N>       Documents to churn per cycle. Default: 25.',
   '  --churn-suffix <ext>  Only churn documents whose URI ends with this suffix.',
   '  --settle <ms>         Wait <ms> after the build before measuring, so a',
   '                        timer-driven residency policy (shed-closed-when-idle)',
   "                        sheds first. Pass above the policy's idleMs; omit to",
   '                        measure the pre-shed (always-keep) baseline.',
   '  --snapshot            Write a `.heapsnapshot` after the build.',
   '  --snapshot-path <p>   Snapshot path. Default: <cwd>/<workspace-basename>.heapsnapshot.',
   '  --profile <dims>      Capture sampled profiles around the build (+churn) into a',
   '                        profiling session. Comma-separated: cpu,alloc,gc,eld,heap.',
   '  --session-out <dir>   Parent directory for the profiling session folder (with --profile).',
   '  --json                Emit the measurement as one JSON document instead of the',
   '                        progress lines: documentCount, buildMs, emptyHeapBytes,',
   '                        afterBuildHeapBytes, and churnGrowthBytes / snapshotPath /',
   '                        profilingSession where the run produced them.',
   logLevelHelpLine(22)
];

/**
 * Validate `--profile` in the PARENT, where the numeric flags beside it are
 * already validated.
 *
 * Returns the RAW string rather than the parsed dimensions on purpose: the child
 * re-parses them, because that is where they are used, and this exists only so a
 * typo fails as a usage error before a process is spawned and a whole head
 * imported. Parsing here and passing the result would change what crosses to the
 * child for no gain.
 */
function validatedProfile(csv: string | undefined, onError: UsageError): string | undefined {
   if (csv === undefined) {
      return undefined;
   }
   try {
      parseProfileDimensions(csv);
   } catch (err: unknown) {
      onError(`Option --profile: ${err instanceof Error ? err.message : String(err)}`);
   }
   return csv;
}

export function parseMeasureMemoryArgs(args: string[], onError: UsageError = exitWithUsage): MeasureMemoryCommandOptions {
   const { servicesModule, workspace, options } = parseHarnessArgs(args, 'measure-memory', VALUE_FLAGS, BOOL_FLAGS, { onError });
   return {
      servicesModule,
      workspace,
      editCycles: numericOption(options['--edits'], '--edits', onError),
      editDocs: numericOption(options['--edit-docs'], '--edit-docs', onError),
      churnSuffix: options['--churn-suffix'],
      settleMs: numericOption(options['--settle'], '--settle', onError),
      writeSnapshot: options['--snapshot'] === 'true',
      snapshotPath: options['--snapshot-path'],
      profile: validatedProfile(options['--profile'], onError),
      sessionOut: options['--session-out'],
      json: options['--json'] === 'true',
      logLevel: logLevelOption(options[LOG_LEVEL_FLAG])
   };
}

export function runMeasureMemoryCommand(args: string[]): Promise<void> {
   if (helpRequested(args, MEASURE_MEMORY_VALUE_FLAGS)) {
      printHelp(MEASURE_MEMORY_HELP);
      return Promise.resolve();
   }
   return runMeasureMemory(parseMeasureMemoryArgs(args));
}
