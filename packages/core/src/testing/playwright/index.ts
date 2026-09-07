/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Playwright-specific test helpers. Kept in a dedicated subpath (not the main
// `@hydranium/core/testing` barrel) so importing the framework's unit-test
// helpers never pulls in `@playwright/test` — which is an OPTIONAL peer here.
export * from './e2e-profiling.js';
export * from './browser-capture-bridge.js';
export * from './server-log-capture.js';
export * from './server-log-fixture.js';
