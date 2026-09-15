/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { APP_PORT, BACKEND_LOG, PROXY_PORT } from './test/reconnect/reconnect-ports.mjs';

// The backend appends to this itself, but the redirect below does not create
// parent directories.
mkdirSync(dirname(BACKEND_LOG), { recursive: true });

/**
 * Reconnect tests, kept out of the main suite because they need a differently
 * configured backend and a proxy in front of it.
 *
 * The backend has to still be holding the session when the browser comes back,
 * which `theia.backend.config.frontendConnectionTimeout` in the app's
 * package.json arranges — Theia's own default of 0 discards it immediately and
 * refuses every reconnect. That setting is deliberately the app's rather than
 * this config's: it is what an adopter would deploy, and the main suite benefits
 * from it too.
 *
 * What IS specific here is the proxy and the ports (3002/3003), so a main-suite
 * run on 3001 and this one cannot drive each other's backend.
 *
 * Run it explicitly:
 *   npm --prefix examples/order-flow/theia-app run test:e2e:reconnect
 *
 * Deliberately not part of `test:e2e`: reconnect timing is less predictable than
 * the rest of the suite, and `break` hits every connection the proxy holds, so
 * two reconnect specs must not overlap.
 */

export default defineConfig({
   // The proxy is started by global setup rather than here: Playwright re-imports
   // this config in every worker, so binding a port at config scope fails on the
   // second worker with EADDRINUSE.
   globalSetup: './test/reconnect/start-proxy.mts',
   // Outside `test/e2e`, which the main config claims wholesale: a spec placed
   // there would also be picked up by the main suite and run with no proxy in
   // front of it, where `break` would do nothing and the test would pass for the
   // wrong reason.
   testDir: './test/reconnect',
   // `break` destroys every connection the proxy holds, so specs cannot overlap.
   workers: 1,
   retries: 0,
   // A reconnect adds socket.io's backoff and a model reload to ordinary editor work.
   timeout: 120_000,
   expect: { timeout: 15_000 },
   reporter: [['list']],
   outputDir: 'test-results/reconnect',
   use: {
      baseURL: `http://localhost:${PROXY_PORT}`,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      actionTimeout: 15_000,
      navigationTimeout: 30_000,
      ...devices['Desktop Chrome']
   },
   webServer: {
      // Redirected to a file rather than piped, because a test has to READ it:
      // the server-side guard reports refusing a stale socket's disconnect, and
      // that line is the only direct evidence the guard ran rather than the
      // session merely having survived. A plain redirect keeps this one process,
      // so Playwright can still stop it — a `tee` pipeline would leave the
      // backend holding the port after the run.
      command: `theia start --plugins=local-dir:./plugins --hostname=0.0.0.0 --port=${APP_PORT} ../workspace > ${BACKEND_LOG} 2>&1`,
      // Waited on directly rather than through the proxy, so a failure to start
      // is reported as the app failing rather than as the proxy being unreachable.
      url: `http://localhost:${APP_PORT}`,
      // Never reused: this suite half-kills connections, so inheriting a backend
      // some other run is using would corrupt that run rather than this one.
      reuseExistingServer: false,
      timeout: 120_000
   }
});
