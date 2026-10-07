/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { runAstGroundTruth, type AstGroundTruthCommandOptions } from './ast-ground-truth.js';
import {
   exitWithUsage,
   HARNESS_VALUE_FLAGS,
   helpRequested,
   importHelpLines,
   LOG_VALUE_FLAGS,
   logHelpLines,
   logOptions,
   parseHarnessArgs,
   printHelp,
   type UsageError
} from './harness-args.js';
import { OUT_FILE_FLAG } from './headless-harness.js';

const VALUE_FLAGS = [OUT_FILE_FLAG, ...LOG_VALUE_FLAGS] as const;

/**
 * Every flag `ast-ground-truth` accepts, derived from the sets the parser is
 * handed so the list cannot claim a flag the parser would reject.
 * {@link HARNESS_VALUE_FLAGS} are consumed by the shared harness parser itself,
 * so they are in neither set.
 */
export const AST_GROUND_TRUTH_FLAGS: readonly string[] = [...HARNESS_VALUE_FLAGS, ...VALUE_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const AST_GROUND_TRUTH_VALUE_FLAGS: readonly string[] = AST_GROUND_TRUTH_FLAGS;

/** The `--help` text, as data, held to {@link AST_GROUND_TRUTH_FLAGS} by a test. */
export const AST_GROUND_TRUTH_HELP: readonly string[] = [
   'Usage: hydranium-cli ast-ground-truth --services <module> [--import <specifier>]... <workspace> [--out-file <file>] [--log-level <lvl>] [--log-file <file>] [--log-file-level <lvl>]',
   '',
   "Tally a workspace's live-model AST nodes by `$type` — the ground truth that",
   '`analyze-heap --validate <gt.json>` checks a heap snapshot against. `<module>`',
   'exports a zero-arg `createServices(): { shared }` thunk. Emits the',
   '`{ documents, totalAstNodes, byType }` JSON on stdout (or `--out-file`).',
   '',
   'Options:',
   '  --services <module>   ESM module exporting `createServices(): { shared }` (required).',
   ...importHelpLines(22),
   '  <workspace>           Workspace root (path or file URI) to build (required).',
   '  --out-file <file>     Write the JSON to this file instead of stdout.',
   ...logHelpLines(22)
];

export function parseAstGroundTruthArgs(args: string[], onError: UsageError = exitWithUsage): AstGroundTruthCommandOptions {
   const { servicesModule, imports, workspace, options } = parseHarnessArgs(args, 'ast-ground-truth', VALUE_FLAGS, [], { onError });
   return { servicesModule, imports, workspace, outFile: options[OUT_FILE_FLAG], ...logOptions(options) };
}

export function runAstGroundTruthCommand(args: string[]): Promise<void> {
   if (helpRequested(args, AST_GROUND_TRUTH_VALUE_FLAGS)) {
      printHelp(AST_GROUND_TRUTH_HELP);
      return Promise.resolve();
   }
   return runAstGroundTruth(parseAstGroundTruthArgs(args));
}
