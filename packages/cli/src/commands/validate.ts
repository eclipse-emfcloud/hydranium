/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { fileURLToPath } from 'node:url';
import { OUT_FILE_FLAG, runDriverChild, type DriverSpawnOptions } from './headless-harness.js';

/**
 * Absolute path to the spawned driver. From `lib/commands/validate.js` the
 * compiled driver sits beside it at `lib/commands/validate-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./validate-driver.js', import.meta.url));

/** Options for the {@link runValidate} subcommand. */
export interface ValidateCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Workspace root (filesystem path or file URI) to build and validate. */
   readonly workspace: string;
   /** Emit the raw JSON result instead of the human report. */
   readonly json?: boolean;
   /** Also fail (non-zero exit) on warnings, not only errors. */
   readonly strict?: boolean;
   /** Write the report to this file instead of stdout; the gate still sets the exit code. */
   readonly outFile?: string;
}

/** Build the argv the driver child parses. Pure → unit-testable. */
export function buildValidateDriverArgs(options: ValidateCommandOptions): string[] {
   const args = ['--services', options.servicesModule, options.workspace];
   if (options.json) {
      args.push('--json');
   }
   if (options.strict) {
      args.push('--strict');
   }
   if (options.outFile !== undefined) {
      args.push(OUT_FILE_FLAG, options.outFile);
   }
   return args;
}

/**
 * Headless workspace validation — a CI gate that builds a workspace, runs the
 * language's validation checks, prints the diagnostics, and exits non-zero when
 * any error is found (`--strict` also fails on warnings). Like the other headless
 * harnesses the binary is language-agnostic, so the head passes a `createServices`
 * module (`--services`); the work runs in a spawned child that dynamic-imports it.
 * The child's exit code propagates to this process so shells and CI see the gate.
 */
export function runValidate(options: ValidateCommandOptions): Promise<void> {
   return runDriverChild(['--max-old-space-size=8192', DRIVER, ...buildValidateDriverArgs(options)], options);
}
