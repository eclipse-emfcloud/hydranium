/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Ports for the reconnect tier, in one place because three files need to agree
 * on them: the config (base URL and web server), the global setup that starts
 * the proxy, and the spec that drives it.
 *
 * Distinct from the main suite's 3001 so the two tiers cannot drive each other's
 * backend — this one half-kills connections, which would look to the other like
 * the very defect it is testing for.
 */
export const APP_PORT = 3002;
export const PROXY_PORT = 3003;
export const CONTROL_PORT = PROXY_PORT + 1000;

/** Where the spec reaches the proxy. The control channel is HTTP because the
 *  spec runs in a worker process, which cannot share objects with the setup. */
export const CONTROL_URL = `http://localhost:${CONTROL_PORT}`;

/**
 * Where the Theia backend's own output is redirected, so a test can read it.
 *
 * Relative to the app directory, which is where both the config and the suite
 * run from. Under `test-results/` so `npm run clean` takes it with the rest, but
 * deliberately BESIDE the tier's `outputDir` rather than inside it: Playwright
 * clears that directory when a run starts, which happens after the config has
 * created it and before the web server writes a byte.
 */
export const BACKEND_LOG = 'test-results/reconnect-backend.log';
