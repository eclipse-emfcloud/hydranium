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
import { runReflect, type ReflectCommandOptions } from './reflect.js';

const VALUE_FLAGS = [OUT_FILE_FLAG, LOG_LEVEL_FLAG] as const;
const BOOL_FLAGS = ['--json'] as const;

/**
 * Every flag `reflect` accepts, derived from the sets the parser is handed so
 * the list cannot claim a flag the parser would reject. `--services` is consumed
 * by the shared harness parser itself, so it is in neither set.
 */
export const REFLECT_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS, ...BOOL_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const REFLECT_VALUE_FLAGS: readonly string[] = [SERVICES_FLAG, ...VALUE_FLAGS];

/** The `--help` text, as data, held to {@link REFLECT_FLAGS} by a test. */
export const REFLECT_HELP: readonly string[] = [
   'Usage: hydranium-cli reflect --services <module> [--json] [--out-file <file>] [--log-level <lvl>]',
   '',
   "Dump a head's grammar/AST reflection — the type hierarchy, each language's",
   'terminals and entry rule, and every cross-reference target. Read-only: no',
   'workspace is built (the reflection is static once the head registers its',
   'language), so `reflect` takes no `<workspace>`. `<module>` is an ESM module',
   'exporting a zero-arg `createServices(): { shared }` thunk. Needs @hydranium/core.',
   '',
   'Options:',
   '  --services <module>   ESM module exporting `createServices(): { shared }` (required).',
   '  --json                Emit the raw JSON reflection instead of the Markdown report.',
   '  --out-file <file>     Write the report to this file instead of stdout. Written',
   '                        only once the report exists, unlike a shell redirection,',
   '                        which truncates the file before the head is even booted.',
   logLevelHelpLine(22)
];

export function parseReflectArgs(args: string[], onError: UsageError = exitWithUsage): ReflectCommandOptions {
   const { servicesModule, options } = parseHarnessArgs(args, 'reflect', VALUE_FLAGS, BOOL_FLAGS, {
      requireWorkspace: false,
      onError
   });
   return {
      servicesModule,
      json: options['--json'] === 'true',
      outFile: options[OUT_FILE_FLAG],
      logLevel: logLevelOption(options[LOG_LEVEL_FLAG])
   };
}

export function runReflectCommand(args: string[]): Promise<void> {
   if (helpRequested(args, REFLECT_VALUE_FLAGS)) {
      printHelp(REFLECT_HELP);
      return Promise.resolve();
   }
   return runReflect(parseReflectArgs(args));
}
