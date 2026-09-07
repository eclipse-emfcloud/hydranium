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
 * Absolute path to the spawned driver. From `lib/commands/reflect.js` the
 * compiled driver sits beside it at `lib/commands/reflect-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./reflect-driver.js', import.meta.url));

/** Options for the {@link runReflect} subcommand. */
export interface ReflectCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Emit the raw JSON reflection instead of the human markdown report. */
   readonly json?: boolean;
   /** Write the report to this file instead of stdout. */
   readonly outFile?: string;
}

/** Build the argv the driver child parses. Pure → unit-testable. */
export function buildReflectDriverArgs(options: ReflectCommandOptions): string[] {
   const args = ['--services', options.servicesModule];
   if (options.json) {
      args.push('--json');
   }
   if (options.outFile !== undefined) {
      args.push(OUT_FILE_FLAG, options.outFile);
   }
   return args;
}

/**
 * Headless grammar/AST reflection — dumps a head's type hierarchy, terminals and
 * cross-reference targets. Read-only: no workspace is built (the reflection is
 * available as soon as the head's services register a language), so unlike the
 * sibling harnesses this subcommand takes only `--services`. The work runs in a
 * spawned child that dynamic-imports the head's `createServices` module, keeping
 * the binary language-agnostic.
 */
export function runReflect(options: ReflectCommandOptions): Promise<void> {
   return runDriverChild(['--max-old-space-size=8192', DRIVER, ...buildReflectDriverArgs(options)], options);
}
