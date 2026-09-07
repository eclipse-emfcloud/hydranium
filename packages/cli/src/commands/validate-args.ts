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
   parseHarnessArgs,
   printHelp,
   SERVICES_FLAG,
   type UsageError
} from './harness-args.js';
import { OUT_FILE_FLAG } from './headless-harness.js';
import { runValidate, type ValidateCommandOptions } from './validate.js';

const VALUE_FLAGS = [OUT_FILE_FLAG, LOG_LEVEL_FLAG] as const;
const BOOL_FLAGS = ['--strict', '--json'] as const;

/**
 * Every flag `validate` accepts, derived from the sets the parser is handed so
 * the list cannot claim a flag the parser would reject. `--services` is consumed
 * by the shared harness parser itself, so it is in neither set.
 */
export const VALIDATE_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS, ...BOOL_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const VALIDATE_VALUE_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS];

/** The `--help` text, as data, held to {@link VALIDATE_FLAGS} by a test. */
export const VALIDATE_HELP: readonly string[] = [
   'Usage: hydranium-cli validate --services <module> <workspace> [--strict] [--json] [--out-file <file>] [--log-level <lvl>]',
   '',
   'Build a workspace headlessly and report its validation diagnostics — a CI gate:',
   'the process exits non-zero when any error is found. `<module>` is an ESM module',
   'exporting a zero-arg `createServices(): { shared }` thunk (the head wires its own',
   'filesystem inside). Needs @hydranium/core.',
   '',
   'Options:',
   '  --services <module>   ESM module exporting `createServices(): { shared }` (required).',
   '  <workspace>           Workspace root (path or file URI) to validate (required).',
   '  --strict              Also fail (non-zero exit) on warnings, not only errors.',
   '  --json                Emit the raw JSON result instead of the human report.',
   '  --out-file <file>     Write the report to this file instead of stdout. The gate',
   '                        still decides the exit code, and the file is written only',
   '                        once the report exists, unlike a shell redirection, which',
   '                        truncates the file before the workspace is even built.',
   logLevelHelpLine(22)
];

export function parseValidateArgs(args: string[], onError: UsageError = exitWithUsage): ValidateCommandOptions {
   const { servicesModule, workspace, options } = parseHarnessArgs(args, 'validate', VALUE_FLAGS, BOOL_FLAGS, { onError });
   return {
      servicesModule,
      workspace,
      strict: options['--strict'] === 'true',
      json: options['--json'] === 'true',
      outFile: options[OUT_FILE_FLAG],
      logLevel: logLevelOption(options[LOG_LEVEL_FLAG])
   };
}

export function runValidateCommand(args: string[]): Promise<void> {
   if (helpRequested(args, VALIDATE_VALUE_FLAGS)) {
      printHelp(VALIDATE_HELP);
      return Promise.resolve();
   }
   return runValidate(parseValidateArgs(args));
}
