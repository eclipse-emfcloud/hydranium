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
import { runModelDocs, type ModelDocsCommandOptions } from './model-docs.js';

const VALUE_FLAGS = [OUT_FILE_FLAG, ...LOG_VALUE_FLAGS] as const;

/**
 * Every flag `model-docs` accepts, derived from the sets the parser is handed
 * so the list cannot claim a flag the parser would reject.
 * {@link HARNESS_VALUE_FLAGS} are consumed by the shared harness parser itself,
 * so they are in neither set.
 */
export const MODEL_DOCS_FLAGS: readonly string[] = [...HARNESS_VALUE_FLAGS, ...VALUE_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const MODEL_DOCS_VALUE_FLAGS: readonly string[] = MODEL_DOCS_FLAGS;

/** The `--help` text, as data, held to {@link MODEL_DOCS_FLAGS} by a test. */
export const MODEL_DOCS_HELP: readonly string[] = [
   'Usage: hydranium-cli model-docs --services <module> [--import <specifier>]... [--out-file <file>] [--log-level <lvl>] [--log-file <file>] [--log-file-level <lvl>]',
   '',
   'Generate a navigable Markdown reference of every AST node type — a type index,',
   'cross-linked super/sub types, a reverse "referenced by" index, and a per-language',
   'grammar summary — for publishing into adopter docs. Read-only: no workspace is',
   'built. Emits Markdown on stdout, or into `--out-file`; the machine-readable form',
   'is `hydranium-cli reflect --json`. `<module>` is an ESM module exporting a',
   'zero-arg `createServices(): { shared }` thunk. Needs @hydranium/core.',
   '',
   'Options:',
   '  --services <module>   ESM module exporting `createServices(): { shared }` (required).',
   ...importHelpLines(22),
   '  --out-file <file>     Write the Markdown to this file instead of stdout. Written',
   '                        only once the report exists, unlike a shell redirection,',
   '                        which truncates the file before the head is even booted.',
   ...logHelpLines(22)
];

export function parseModelDocsArgs(args: string[], onError: UsageError = exitWithUsage): ModelDocsCommandOptions {
   const { servicesModule, imports, options } = parseHarnessArgs(args, 'model-docs', VALUE_FLAGS, [], {
      requireWorkspace: false,
      onError
   });
   return { servicesModule, imports, outFile: options[OUT_FILE_FLAG], ...logOptions(options) };
}

export function runModelDocsCommand(args: string[]): Promise<void> {
   if (helpRequested(args, MODEL_DOCS_VALUE_FLAGS)) {
      printHelp(MODEL_DOCS_HELP);
      return Promise.resolve();
   }
   return runModelDocs(parseModelDocsArgs(args));
}
