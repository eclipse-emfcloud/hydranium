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
import {
   attachServerLog,
   DEFAULT_SERVER_LOG_ATTACH_ENV,
   findUnexpectedServerLogLines,
   markServerLog,
   resolveServerLogPath
} from './server-log-capture.js';
import { readServerLogRegion } from './server-log-region.js';

export interface ServerLogFixtures {
   /**
    * Workspace path for the current test. Defaults to `''` (capture skipped);
    * adopters override it with a fixture deriving from their app.
    * Requires a **per-test app fixture** — a per-spec `beforeAll` app lives in a
    * closure a fixture cannot read, so those suites use `markServerLog` /
    * `attachServerLog` in `beforeEach` / `afterEach` instead.
    */
   serverLogWorkspace: string;
   /**
    * Fail a test whose part of the server log holds a `Warn` or `Error` line
    * that {@link serverLogAllowlist} does not match. Off by default; reads
    * nothing when capture is off.
    */
   serverLogClean: boolean;
   /**
    * The `Warn` and `Error` lines {@link serverLogClean} lets through: each key
    * is why the line is expected, and its pattern is matched against the whole
    * line, label and timestamp included. A pattern takes neither the `g` nor
    * the `y` flag, which make `test` resume from its last match. An object
    * rather than a list, because Playwright reads an array whose second entry
    * is an object as a fixture's `[value, options]`.
    */
   serverLogAllowlist: Readonly<Record<string, RegExp>>;
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
 * Set `serverLogClean` to also fail a test on an unexpected `Warn` or `Error`.
 */
export const serverLogFixtures: Fixtures<ServerLogTestFixtures, object, PlaywrightTestArgs & PlaywrightTestOptions> = {
   serverLogWorkspace: ['', { option: true }],
   serverLogClean: [false, { option: true }],
   serverLogAllowlist: [{}, { option: true }],
   serverLogCapture: [
      async ({ serverLogWorkspace, serverLogClean, serverLogAllowlist }, use): Promise<void> => {
         if (!serverLogWorkspace) {
            await use(undefined);
            return;
         }
         markServerLog(base.info(), serverLogWorkspace);
         await use(undefined);
         const file = resolveServerLogPath(serverLogWorkspace);
         const region = file ? readServerLogRegion(file) : '';
         let problem: string | undefined;
         if (serverLogClean) {
            const unexpected = findUnexpectedServerLogLines(region, serverLogAllowlist);
            if (unexpected.length > 0) {
               problem = `The server logged ${unexpected.length} unexpected Warn or Error line(s):\n${unexpected.join('\n')}`;
            }
         }
         // The failure-only policy reads the test's status, which failing here
         // does not change; a run set to attach nothing still attaches nothing.
         const attachOn = process.env[DEFAULT_SERVER_LOG_ATTACH_ENV] === 'never' ? 'never' : 'always';
         await attachServerLog(base.info(), serverLogWorkspace, problem ? { attachOn } : {});
         if (problem) {
            throw new Error(problem);
         }
      },
      { auto: true }
   ]
};

/** Pre-extended test with {@link serverLogFixtures} applied, for adopters on the plain base. */
export const test = base.extend<ServerLogTestFixtures>(serverLogFixtures);
