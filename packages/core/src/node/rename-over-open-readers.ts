/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fsp from 'node:fs/promises';

/**
 * Errnos Windows raises when a replacing `rename` meets a handle already on the
 * destination open. POSIX renames are unaffected by open handles, so these
 * cannot fire there and the retry below costs nothing.
 */
export const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * How long a replacing rename may keep retrying before it gives up.
 *
 * BOUNDED, not open-ended: a genuine permission fault raises the same errno as
 * contention and is distinguishable from it only by never clearing, so an
 * unbounded wait would convert a hard error into a hang.
 *
 * The figure is a judgement, not a measurement, and the honest bound on it is
 * that the previous 2s was observed EXHAUSTED on a loaded Windows CI runner
 * while no upper bound has been established. What would settle it is recording
 * how long a real contended rename takes to clear. graceful-fs tolerates 60s
 * for Windows rename contention, but that is weaker support than it looks: it
 * retries only where the destination has GONE, which is the opposite of
 * replacing one a reader holds open.
 */
export const RENAME_BUDGET_MS = 10_000;

/** Seams for the test, which cannot make a real rename fail on demand. */
export interface RenameOverOpenReadersOptions {
   readonly rename?: (from: string, to: string) => Promise<void>;
   readonly budgetMs?: number;
}

/**
 * `rename` the staged content over `destination`, retrying while Windows
 * reports the destination as held open.
 *
 * The staging file exists so a reader never sees a half-written file, and on
 * Windows the very presence of that reader is what makes the replacing rename
 * fail — so the indivisible write breaks under exactly the contention it was
 * built for, and it breaks intermittently, which is worse than never working.
 * A reader's handle is released in milliseconds, so waiting turns a spurious
 * failure into a slightly later success.
 *
 * Exhausting the budget rethrows the last failure, leaving the caller's cleanup
 * and error contract unchanged. An errno OUTSIDE the contention set is rethrown
 * without waiting at all: retrying a fault that will not clear only delays it.
 */
export async function renameOverOpenReaders(
   staging: string,
   destination: string,
   options: RenameOverOpenReadersOptions = {}
): Promise<void> {
   const rename = options.rename ?? fsp.rename;
   const deadline = Date.now() + (options.budgetMs ?? RENAME_BUDGET_MS);
   for (let attempt = 0; ; attempt++) {
      try {
         await rename(staging, destination);
         return;
      } catch (err: unknown) {
         const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : undefined;
         if (code === undefined || !RENAME_CONTENTION_CODES.has(code) || Date.now() >= deadline) {
            throw err;
         }
         // Backs off to keep a long contention window from spinning, capped so
         // a late attempt still lands promptly once the handle is released.
         await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 50)));
      }
   }
}
