/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { captureServerLog, DEFAULT_SERVER_LOG_DIR_ENV } from '@hydranium/core/testing/playwright';
import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Runs the browser app's specs against this Electron application, the way
 * Theia's own `ui-tests-electron` does: `USE_ELECTRON` makes `TheiaAppLoader`
 * launch Electron instead of opening a page, so there is no `webServer`.
 *
 * Left out: the reload spec drives a browser reload, and the restart and
 * reconnect tiers run only against the browser backend.
 */
process.env.USE_ELECTRON = 'true';

const serverLogDir = process.env[DEFAULT_SERVER_LOG_DIR_ENV] ?? resolve(import.meta.dirname, 'test-results', 'server-logs');
mkdirSync(serverLogDir, { recursive: true });
const serverLog = captureServerLog({ dir: serverLogDir });
// Electron starts from a worker and inherits its environment, which the
// workers take from this process.
Object.assign(process.env, serverLog.env);

export default defineConfig({
   testDir: '../theia-app/test/e2e',
   testIgnore: /order-flow-reload\.spec\.mts$/,
   grepInvert: /@restart/,
   timeout: 60_000,
   expect: { timeout: 15_000 },
   retries: process.env.CI ? 1 : 0,
   // Each worker runs a whole application: Electron, backend, plugin host and
   // language server. More at once start slower than `beforeAll` allows.
   workers: 2,
   reporter: [
      ['list'],
      ...(process.env.CI
         ? ([['github'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/e2e/junit.xml' }]] as const)
         : []),
      ...(serverLog.reporter ? [serverLog.reporter] : [])
   ],
   outputDir: 'test-results/e2e',
   use: {
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      actionTimeout: 15_000
   }
});
