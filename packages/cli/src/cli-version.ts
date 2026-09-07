/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { readFileSync } from 'node:fs';

/** This package's own manifest, reachable at the same relative path from `src/` and `lib/`. */
const CLI_MANIFEST = new URL('../package.json', import.meta.url);

/**
 * The version of the running binary.
 *
 * Read from the manifest rather than emitted as a constant at build time: a
 * generated constant is a second copy of a number the manifest already carries,
 * and nothing goes red while the two disagree.
 *
 * Throws rather than reporting `unknown`: every caller turns the number into a
 * claim someone else acts on — a pinned dependency range, a version in a bug
 * report — where a placeholder is worse than a failure.
 */
export function readCliVersion(): string {
   const manifest = JSON.parse(readFileSync(CLI_MANIFEST, 'utf-8')) as { version?: unknown };
   if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error('hydranium-cli cannot read its own version from its package manifest.');
   }
   return manifest.version;
}
