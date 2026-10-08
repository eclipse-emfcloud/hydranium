/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Fills the VS Code cache with retries: `@vscode/test-electron` checks the
// pinned version with the update server once, and only while it is uncached.
// `test:host` reads the cache under the working directory, so run this from the
// package directory, as `npm run` does.

import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { VSCODE_VERSION } from '../test/vscode-version.mts';

const ATTEMPTS = 3;
// A failed attempt can end within a second, so back-to-back retries would all
// land in the same outage; waiting longer each time spreads them out.
const RETRY_DELAY_MS = 5_000;
const cachePath = resolve(import.meta.dirname, '..', '.vscode-test');

for (let attempt = 1; ; attempt++) {
   try {
      await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath });
      break;
   } catch (error: unknown) {
      if (attempt === ATTEMPTS) {
         throw error;
      }
      const delayMs = attempt * RETRY_DELAY_MS;
      console.warn(`Downloading VS Code ${VSCODE_VERSION} failed on attempt ${attempt} of ${ATTEMPTS}; retrying in ${delayMs} ms.`, error);
      await setTimeout(delayMs);
   }
}
