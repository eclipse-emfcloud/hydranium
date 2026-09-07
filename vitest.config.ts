/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineConfig } from 'vitest/config';

// Root config for the Vitest IDE extension (and a bare `vitest` at the repo
// root): it lists every package's config as a project so the extension can
// discover and run all suites from one workspace root. The extension requires a
// root config — without one it cannot resolve a workspace and fails to run.
//
// Turbo does NOT use this. Each package's `test` script runs `vitest run` in the
// package dir, which resolves that package's own vitest.config.ts (Vitest reads
// the config at its root/cwd and does not walk up), so the per-package execution
// and caching model is unchanged.
export default defineConfig({
   test: {
      // Globbed rather than enumerated, so an example that gains a suite is
      // discoverable without editing this file — an omission here is invisible
      // (the suite simply never appears in the IDE) rather than an error.
      //
      // BOTH example depths, because `examples/` holds two shapes: a multi-package
      // family groups its hosts a level down (`examples/<family>/<host>`), while a
      // single-package example sits directly under `examples/`. A `*` does not
      // cross a separator, so one pattern silently covers only one shape — and by
      // the note above, silently is the whole hazard.
      projects: ['packages/*/vitest.config.ts', 'examples/*/vitest.config.ts', 'examples/*/*/vitest.config.ts']
   }
});
