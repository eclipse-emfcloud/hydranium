/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { captureServerLog, DEFAULT_SERVER_LOG_DIR_ENV } from '@hydranium/core/testing/playwright';
import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Playwright configuration for the order-flow Theia demo app.
 *
 * The `webServer` block boots `npm start` (Theia backend) before the suite runs
 * and waits for the port to accept connections. Re-uses an existing server when
 * one is already running, which speeds up `--ui` iteration. The build is
 * intentionally NOT chained in — `npm run test:e2e` expects `lib/` and the
 * linked plugin to exist.
 *
 * **Port 3001, not Theia's default 3000.** A second Theia app on the default
 * port is routinely run beside this one, and a shared port silently makes one
 * suite drive the other's binary.
 */

/**
 * Server-log capture is on BY DEFAULT here, deliberately, rather than left
 * opt-in as the framework helper ships it.
 *
 * `captureServerLog()` is opt-in via `HYDRANIUM_SERVER_LOG_DIR` and returns an
 * empty env when it is unset — fine for a suite that is only ever run to get a
 * pass/fail, and actively costly for this one. Everything under test here is a
 * multi-process handshake (Theia backend → plugin host → language server → GLSP
 * socket) whose failure mode is a promise that never settles, so a bare
 * "expected visible" timeout says nothing at all about which hop stalled. The
 * default below means the log is already on disk and already attached to the
 * failing test the FIRST time it fails, instead of after a re-run with the env
 * set. `HYDRANIUM_SERVER_LOG_DIR` still wins when it is set.
 */
const serverLogDir = process.env[DEFAULT_SERVER_LOG_DIR_ENV] ?? resolve(import.meta.dirname, 'test-results', 'server-logs');
// The server's own file-tee creates this on demand, but `markServerLog` appends
// before the server has necessarily written anything, and `appendFileSync` does
// not create parents.
mkdirSync(serverLogDir, { recursive: true });
// `captureServerLog` publishes the dir onto `HYDRANIUM_SERVER_LOG_DIR` itself, so
// the runner-side halves — `markServerLog` / `attachServerLog`, which the
// framework's `serverLogFixtures` calls with no options — pick up this default too.
// A config runs in the Playwright main process before any worker forks, so the
// workers inherit it.
const serverLog = captureServerLog({ dir: serverLogDir });

/**
 * Which invocation of this config is running, and therefore which subdirectory
 * of `test-results/` it owns.
 *
 * THIS CONFIG RUNS TWICE — `test:e2e` excludes `@restart`, `test:e2e:restart`
 * selects it — and Playwright CLEARS `outputDir` when a run starts. Sharing one
 * directory meant the second invocation deleted the first's JUnit report, so
 * eleven passing cases went missing from the artefact with nothing red to show
 * for it. Naming only the FILE apart does not help, because the directory is
 * what gets cleared.
 *
 * One variable drives both the directory and the report path below, so they
 * cannot drift apart — which is the mistake this replaces.
 */
const tier = process.env.HYDRANIUM_PLAYWRIGHT_TIER ?? 'e2e';

export default defineConfig({
   testDir: './test/e2e',
   timeout: 60_000,
   expect: { timeout: 15_000 },
   retries: process.env.CI ? 1 : 0,
   // The rename reporter turns each `<workspace-token>.log` into `<spec>.log` once
   // every server process has exited, so the captured logs are navigable by spec
   // name rather than by opaque token.
   // JUnit joins the HTML one under CI so this tier's per-case durations land
   // under `test-results/` beside the vitest tiers', making one query answer
   // "what is closest to its timeout" across every tier. The HTML report
   // stays: it is what a human opens, and it carries the traces.
   reporter: [
      ['list'],
      ...(process.env.CI
         ? ([
              // Playwright's own GitHub reporter, which annotates a failure on
              // the diff. It is the only one of the three a reader sees WITHOUT
              // downloading something, and it needs no workflow permission.
              ['github'],
              ['html', { open: 'never' }],
              ['junit', { outputFile: `test-results/${tier}/junit.xml` }]
           ] as const)
         : []),
      ...(serverLog.reporter ? [serverLog.reporter] : [])
   ],
   outputDir: `test-results/${tier}`,
   use: {
      baseURL: 'http://localhost:3001',
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      // Theia's plugin-host process can take a few seconds to deploy the local
      // plugin; give navigation actions room to wait for that to finish before
      // failing the test.
      actionTimeout: 15_000,
      navigationTimeout: 30_000
   },
   projects: [
      {
         name: 'chromium',
         use: { ...devices['Desktop Chrome'] }
      }
   ],
   webServer: {
      command: 'npm start',
      url: 'http://localhost:3001',
      // Note the interaction with the capture above: a server this suite did NOT
      // start never saw `serverLog.env`, so a reused backend from a manual
      // `npm start` produces no log. Kill it first when a capture is what you are
      // after — and also when the change under test could affect startup, because
      // a warm backend never exercises the cold path and turns a cold-start
      // regression into a fast, meaningless pass.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: serverLog.env,
      stdout: 'pipe',
      stderr: 'pipe'
   }
});
