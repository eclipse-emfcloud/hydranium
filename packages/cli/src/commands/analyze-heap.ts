/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { fileURLToPath } from 'node:url';
import { spawnNodeChild } from './headless-harness.js';

/**
 * Absolute path to the bundled memlab-based analyzer (a standalone ESM script
 * shipped under the package's `heap-analysis/` assets, not the compiled `lib/`).
 * From `lib/commands/analyze-heap.js` that is `../../heap-analysis/analyze-heap.mjs`.
 */
const ANALYZER = fileURLToPath(new URL('../../heap-analysis/analyze-heap.mjs', import.meta.url));

/** `true` when the optional `@memlab/heap-analysis` dependency is installed and resolvable. */
function memlabInstalled(): boolean {
   const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
   try {
      resolve?.('@memlab/heap-analysis');
      return resolve !== undefined;
   } catch {
      return false;
   }
}

/**
 * Selects the JSON-vs-JSON comparison, which reads two analysis artifacts and
 * needs neither a snapshot nor memlab. Declared here rather than in the args
 * module so the guard below and the flag list read the same constant.
 */
export const DIFF_FLAG = '--diff';

/** Test-only injection seam for {@link runAnalyzeHeap}, mirroring the sibling harness commands. */
export interface AnalyzeHeapDeps {
   /** Capture the node argv instead of spawning the real analyzer child. */
   readonly __spawnForTest?: (execArgs: string[]) => Promise<number>;
   /** Override the memlab-availability check. */
   readonly __memlabInstalledForTest?: () => boolean;
}

/**
 * Run the heap-snapshot analyzer. Memlab is an OPTIONAL PEER dependency and a
 * heavy one — it drags in a browser download — so an install of this package
 * pulls in nothing, and a caller that wants heap analysis opts in with the
 * install line the guard below prints. This subcommand loads it only when
 * invoked, by spawning the bundled analyzer in a child process with the large
 * heap memlab needs. All arguments are forwarded verbatim — the analyzer owns
 * how it reads them.
 *
 * The guard is skipped for {@link DIFF_FLAG}, which the analyzer short-circuits
 * before any memlab import: refusing it would demand ~86 MB of dependency for a
 * run that reads two JSON files. Help is intercepted earlier still, by the args
 * module, so it never reaches this function.
 */
export async function runAnalyzeHeap(args: string[], deps: AnalyzeHeapDeps = {}): Promise<void> {
   const isMemlabInstalled = deps.__memlabInstalledForTest ?? memlabInstalled;
   if (!args.includes(DIFF_FLAG) && !isMemlabInstalled()) {
      console.error(
         'analyze-heap needs the optional @memlab/heap-analysis dependency (heavy: ~86 MB).\n' +
            'It is an optional peer dependency, so it is not installed by default; add it with:\n' +
            '  npm install @memlab/core @memlab/heap-analysis'
      );
      process.exitCode = 1;
      return;
   }
   const spawnChild = deps.__spawnForTest ?? spawnNodeChild;
   const code = await spawnChild(['--max-old-space-size=8192', ANALYZER, ...args]);
   if (code) {
      process.exitCode = code;
   }
}
