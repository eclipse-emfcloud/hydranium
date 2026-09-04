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
 * Absolute path to the spawned driver. From `lib/commands/ast-ground-truth.js`
 * the compiled driver sits beside it at `lib/commands/ast-ground-truth-driver.js`.
 */
const DRIVER = fileURLToPath(new URL('./ast-ground-truth-driver.js', import.meta.url));

/** Options for the {@link runAstGroundTruth} subcommand. */
export interface AstGroundTruthCommandOptions extends DriverSpawnOptions {
   /** ESM module exporting a zero-arg `createServices(): { shared }` thunk. */
   readonly servicesModule: string;
   /** Workspace root (filesystem path or file URI) to build. */
   readonly workspace: string;
   /** Write the JSON to this file instead of stdout. */
   readonly outFile?: string;
}

/** Build the argv the driver child parses. Pure → unit-testable. */
export function buildGroundTruthDriverArgs(options: AstGroundTruthCommandOptions): string[] {
   const args = ['--services', options.servicesModule, options.workspace];
   if (options.outFile !== undefined) {
      args.push(OUT_FILE_FLAG, options.outFile);
   }
   return args;
}

/**
 * Headless live-model `$type` census — the ground truth the offline heap
 * analyzer validates a snapshot's classification against
 * (`analyze-heap --validate <gt.json>`). Like `measure-memory`, the binary is
 * language-agnostic, so the head passes a `createServices` module (`--services`);
 * the work runs in a spawned child that dynamic-imports it, builds the workspace,
 * and emits the `{ documents, totalAstNodes, byType }` JSON on stdout (or
 * `--out-file`). No `--expose-gc` needed — this walks the AST, it does not weigh it.
 */
export function runAstGroundTruth(options: AstGroundTruthCommandOptions): Promise<void> {
   return runDriverChild(['--max-old-space-size=8192', DRIVER, ...buildGroundTruthDriverArgs(options)], options);
}
