/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { fileURLToPath } from 'node:url';
import { runDriverChild, type DriverSpawnOptions } from './headless-harness.js';

/**
 * Absolute path to the spawned driver. From `lib/commands/lint-grammar.js` the
 * compiled driver sits beside it at `lib/commands/lint-grammar-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./lint-grammar-driver.js', import.meta.url));

/** Options for the {@link runLintGrammar} subcommand. */
export interface LintGrammarCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Property names that satisfy the nameability convention. Empty → the framework default `name`. */
   readonly nameProperties?: readonly string[];
   /** Emit the raw JSON result instead of the human report. */
   readonly json?: boolean;
   /** Also fail (non-zero exit) on warnings, not only errors. */
   readonly strict?: boolean;
}

/** Build the argv the driver child parses. Pure → unit-testable. */
export function buildLintGrammarDriverArgs(options: LintGrammarCommandOptions): string[] {
   const args = ['--services', options.servicesModule];
   for (const property of options.nameProperties ?? []) {
      args.push('--name-property', property);
   }
   if (options.json) {
      args.push('--json');
   }
   if (options.strict) {
      args.push('--strict');
   }
   return args;
}

/**
 * Headless grammar-convention lint — a CI gate that checks a head's grammar against
 * the framework's expectations (nameable cross-reference targets, an entry rule) and
 * exits non-zero when a violation is found (`--strict` also fails on warnings).
 * Read-only: no workspace is built (the reflection is static once the head registers
 * its language), so this subcommand takes only `--services` and the name-property
 * overrides. The work runs in a spawned child that dynamic-imports the head's
 * `createServices` module, keeping the binary language-agnostic.
 */
export function runLintGrammar(options: LintGrammarCommandOptions): Promise<void> {
   return runDriverChild(['--max-old-space-size=8192', DRIVER, ...buildLintGrammarDriverArgs(options)], options);
}
