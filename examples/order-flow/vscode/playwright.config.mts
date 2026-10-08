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
 * The webview tier: each spec launches VS Code itself, so there is no
 * `webServer`. One worker, because a second would race the first launch's
 * download. Server-log capture is on by default, because a stalled hop shows
 * up here only as a timeout.
 */
const serverLogDir = process.env[DEFAULT_SERVER_LOG_DIR_ENV] ?? resolve(import.meta.dirname, 'test-results', 'server-logs');
mkdirSync(serverLogDir, { recursive: true });
// Publishes the directory onto the env var the launch fixture and the
// attach-on-failure fixture read in the worker.
const serverLog = captureServerLog({ dir: serverLogDir });

export default defineConfig({
   testDir: './test/e2e',
   timeout: 90_000,
   expect: { timeout: 15_000 },
   retries: process.env.CI ? 1 : 0,
   workers: 1,
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
