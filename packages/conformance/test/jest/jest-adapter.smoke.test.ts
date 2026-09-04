/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The ONE Jest-run smoke for the shipped `@hydranium/conformance/jest` adapter.
 *
 * The framework's own suites run on Vitest, through
 * `@hydranium/conformance/vitest`, so without this file nothing would exercise
 * the `/jest` binding and it could rot unnoticed. It runs under this package's
 * self-contained `jest.config.cjs` (Vitest excludes `test/jest/**`), importing
 * the adapter through its PUBLISHED subpath so the `./jest` export map entry +
 * built artifact are exercised exactly as a Jest-based adopter would.
 *
 * `languages: []` plans only the server-level LSP checks, which a trivial
 * structural fake satisfies with no live server — so the smoke drives the
 * adapter's `describe` + `it` + `afterAll` bindings end-to-end. (`it.skip`
 * shares `it`'s binding surface.)
 */

import { runLspConformance, type LspConformanceDriver } from '@hydranium/conformance/jest';

const fakeDriver: LspConformanceDriver = {
   initialize: async () => ({ capabilities: { textDocumentSync: 1, completionProvider: {} } }),
   openDocument: () => undefined,
   changeDocument: () => undefined,
   nextDiagnostics: async () => [],
   completion: async () => ({ items: [] }),
   shutdown: async () => undefined,
   dispose: () => undefined
};

runLspConformance({ connect: () => fakeDriver, languages: [], suiteTitle: 'conformance/jest adapter smoke' });
