/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { configDefaults, defineConfig, type UserConfigExport } from 'vitest/config';

/**
 * Shared Vitest base for every hydranium package. A package's `vitest.config.ts`
 * calls `definePackageVitestConfig('<name>')`, mirroring the old per-package
 * `jest.config.cjs` that set only `displayName`.
 *
 * ONE base covers both ESM and CommonJS packages: Vitest transforms TypeScript
 * via esbuild and runs it in its own module runner, so the Jest ESM/CommonJS
 * base split (`jest.base.cjs` / `jest.base.esm.cjs`, the
 * `--experimental-vm-modules` flag, the `.js`→`.ts` `moduleNameMapper`) is no
 * longer needed — Vite resolves `.js` specifiers to their `.ts` source itself.
 *
 * `include` is package-relative (`test/**`), so `lib/` is never scanned and a
 * stray test name can't silently widen the suite. `options.exclude` lets a
 * package carve out files a sibling runner owns (the conformance kit keeps one
 * Jest smoke under `test/jest/**`). A package needing more (e.g.
 * glsp-client-theia's dep pre-bundling) `mergeConfig`s its extras onto this.
 */
export function definePackageVitestConfig(name: string, options: { exclude?: readonly string[] } = {}): UserConfigExport {
   return defineConfig({
      test: {
         name,
         environment: 'node',
         include: ['test/**/*.{test,spec}.{ts,tsx}'],
         // A shared CI executor runs this suite several times slower than a
         // developer machine does under the SAME parallel turbo load — enough
         // that Vitest's 5s default leaves a test costing ~1s locally with no
         // margin, and it fails as a timeout naming the test rather than the
         // executor. Raised only under CI so local runs stay strict, which is
         // the right asymmetry: a slow test is cheapest to find where it is
         // being written, and a hung one still fails without wedging a job.
         testTimeout: process.env.CI ? 20_000 : 5_000,
         // A JUnit file ALONGSIDE the console reporter, under CI only. Its
         // per-case `time` attribute is the point: the console output totals a
         // package but names no test's cost, so "which test is closest to the
         // timeout" is unanswerable from a green run and the next one is found
         // by it going red. The path is package-relative, so turbo's per-package
         // invocations cannot overwrite each other.
         ...(process.env.CI ? { reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml' }] as const] } : {}),
         ...(options.exclude ? { exclude: [...configDefaults.exclude, ...options.exclude] } : {})
      }
   });
}
