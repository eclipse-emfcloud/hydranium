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
 * Absolute path to the spawned driver. From `lib/commands/model-docs.js` the
 * compiled driver sits beside it at `lib/commands/model-docs-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./model-docs-driver.js', import.meta.url));

/** Options for the {@link runModelDocs} subcommand. */
export interface ModelDocsCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Write the Markdown to this file instead of stdout. */
   readonly outFile?: string;
}

/** Build the argv the driver child parses. Pure → unit-testable. */
export function buildModelDocsDriverArgs(options: ModelDocsCommandOptions): string[] {
   const args = ['--services', options.servicesModule];
   if (options.outFile !== undefined) {
      args.push(OUT_FILE_FLAG, options.outFile);
   }
   return args;
}

/**
 * Headless model-surface documentation — emits a navigable Markdown reference of
 * every AST node type (type index, cross-linked super/sub types, a reverse
 * "referenced by" index, and a per-language grammar summary), suitable for
 * publishing into adopter docs. Read-only: no workspace is built (the reflection is
 * static once the head registers its language), so it takes no `<workspace>`.
 * There is no `--json` — the machine-readable form is `hydranium-cli reflect --json`.
 * The work runs in a spawned child that dynamic-imports the head's `createServices`
 * module, keeping the binary language-agnostic.
 */
export function runModelDocs(options: ModelDocsCommandOptions): Promise<void> {
   return runDriverChild(['--max-old-space-size=8192', DRIVER, ...buildModelDocsDriverArgs(options)], options);
}
