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
import { runLintGrammar, type LintGrammarCommandOptions } from './lint-grammar.js';

const VALUE_FLAGS = [LOG_LEVEL_FLAG] as const;
const BOOL_FLAGS = ['--strict', '--json'] as const;
const REPEATABLE_VALUE_FLAGS = ['--name-property'] as const;

/**
 * Every flag `lint-grammar` accepts, derived from the sets the parser is handed
 * so the list cannot claim a flag the parser would reject. `--services` is
 * consumed by the shared harness parser itself, so it is in neither set.
 */
export const LINT_GRAMMAR_FLAGS: readonly string[] = [SERVICES_FLAG, ...REPEATABLE_VALUE_FLAGS, ...VALUE_FLAGS, ...BOOL_FLAGS];

/** The subset that takes a value, so `--help` in a value position reads as data. */
export const LINT_GRAMMAR_VALUE_FLAGS: readonly string[] = [SERVICES_FLAG, ...REPEATABLE_VALUE_FLAGS, ...VALUE_FLAGS];

/** The `--help` text, as data, held to {@link LINT_GRAMMAR_FLAGS} by a test. */
export const LINT_GRAMMAR_HELP: readonly string[] = [
   'Usage: hydranium-cli lint-grammar --services <module> [--name-property <p>]... [--strict] [--json] [--log-level <lvl>]',
   '',
   "Check a head's grammar against the framework's conventions — a CI gate: the",
   'process exits non-zero when a violation is found. Read-only: no workspace is',
   'built (the grammar is static once the head registers its language), so',
   '`lint-grammar` takes no `<workspace>`. Checks that every concrete cross-reference',
   'target carries a name property (else references cannot resolve) and that each',
   'language declares an entry rule. `<module>` is an ESM module exporting a',
   'zero-arg `createServices(): { shared }` thunk. Needs @hydranium/core.',
   '',
   'Options:',
   '  --services <module>    ESM module exporting `createServices(): { shared }` (required).',
   '  --name-property <p>    Property that satisfies the nameability convention',
   '                         (repeatable). Default: name.',
   '  --strict               Also fail (non-zero exit) on warnings, not only errors.',
   '  --json                 Emit the raw JSON result instead of the human report.',
   logLevelHelpLine(23)
];

export function parseLintGrammarArgs(args: string[], onError: UsageError = exitWithUsage): LintGrammarCommandOptions {
   const { servicesModule, options, values } = parseHarnessArgs(args, 'lint-grammar', VALUE_FLAGS, BOOL_FLAGS, {
      requireWorkspace: false,
      repeatableValueFlags: REPEATABLE_VALUE_FLAGS,
      onError
   });
   return {
      servicesModule,
      nameProperties: values['--name-property'],
      strict: options['--strict'] === 'true',
      json: options['--json'] === 'true',
      logLevel: logLevelOption(options[LOG_LEVEL_FLAG])
   };
}

export function runLintGrammarCommand(args: string[]): Promise<void> {
   if (helpRequested(args, LINT_GRAMMAR_VALUE_FLAGS)) {
      printHelp(LINT_GRAMMAR_HELP);
      return Promise.resolve();
   }
   return runLintGrammar(parseLintGrammarArgs(args));
}
