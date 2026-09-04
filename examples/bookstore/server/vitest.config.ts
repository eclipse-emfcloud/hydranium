/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineConfig } from 'vitest/config';

// Vitest transforms TypeScript itself and resolves `.js` specifiers to their
// `.ts` source, so tests import from `../src/` with the same specifiers the
// compiled output uses. `include` is scoped to `test/` so `lib/` is never
// scanned; `npm test` runs `typecheck:test` first, because the esbuild
// transform strips types without checking them.

export default defineConfig({
   test: {
      environment: 'node',
      include: ['test/**/*.{test,spec}.ts']
   }
});
