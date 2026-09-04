/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// This module imports `@playwright/test` (an OPTIONAL peer) to compose a fixture.
// The plain functions in `server-log-capture.ts` stay playwright-free; only
// adopters that use this fixture need `@playwright/test` installed.
import { test as base, type Fixtures, type PlaywrightTestArgs, type PlaywrightTestOptions } from '@playwright/test';
import { attachServerLog, markServerLog } from './server-log-capture.js';

export interface ServerLogFixtures {
   /**
    * Workspace path for the current test. Defaults to `''` (capture skipped);
    * adopters override it with a fixture deriving from their app.
    * Requires a **per-test app fixture** — a per-spec `beforeAll` app lives in a
    * closure a fixture cannot read, so those suites use `markServerLog` /
    * `attachServerLog` in `beforeEach` / `afterEach` instead.
    */
   serverLogWorkspace: string;
}

/** Full fixture set including the internal side-effect-only auto fixture. */
interface ServerLogTestFixtures extends ServerLogFixtures {
   /** Internal auto fixture: marks on setup, attaches on teardown. Provides no value. */
   serverLogCapture: void;
}

/**
 * Composable fixtures for per-test server-log capture: writes the start marker
 * before each test (setup) and attaches the log on failure after each test
 * (teardown) — i.e. the `beforeEach` + `afterEach` pair fused into one auto
 * fixture. Compose onto any test base, or use the pre-extended {@link test}.
 * Override `serverLogWorkspace` to wire the workspace; otherwise it's inert.
 */
export const serverLogFixtures: Fixtures<ServerLogTestFixtures, object, PlaywrightTestArgs & PlaywrightTestOptions> = {
   serverLogWorkspace: ['', { option: true }],
   serverLogCapture: [
      async ({ serverLogWorkspace }, use): Promise<void> => {
         if (serverLogWorkspace) {
            markServerLog(base.info(), serverLogWorkspace);
         }
         await use(undefined);
         if (serverLogWorkspace) {
            await attachServerLog(base.info(), serverLogWorkspace);
         }
      },
      { auto: true }
   ]
};

/** Pre-extended test with {@link serverLogFixtures} applied, for adopters on the plain base. */
export const test = base.extend<ServerLogTestFixtures>(serverLogFixtures);
