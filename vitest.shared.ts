/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { configDefaults, defineConfig, type UserConfigExport } from 'vitest/config';

// `vscode-jsonrpc` 9 exports `./browser` under the `browser` condition alone, so
// a Node test of a browser transport reaches it by path. A `browser` resolve
// condition instead breaks Langium's test helpers' imports from `vscode-languageserver`.
//
// `vscode-languageserver/browser` goes to the NODE entry instead: its browser
// entry `require`s `vscode-languageserver-protocol/browser` through Node's own
// resolver, which no alias reaches and which rejects the subpath. The two
// entries share `createConnection(features, reader, writer, options)`, the one
// form the worker-hosted head uses, so a Node test runs the head's real code
// over the port transport; only the browser entry's own module stays for the
// browser e2e tier to load.
const require = createRequire(import.meta.url);
const jsonrpcBrowser = join(dirname(require.resolve('vscode-jsonrpc')), '../browser/main.js');
const languageServerNode = join(dirname(require.resolve('vscode-languageserver')), '../node/main.js');

/**
 * Shared Vitest base for every hydranium package. A package's `vitest.config.ts`
 * calls `definePackageVitestConfig('<name>')`, mirroring the old per-package
 * `jest.config.cjs` that set only `displayName`.
 *
 * ONE base covers both ESM and CommonJS packages: Vitest transforms TypeScript
 * itself and runs it in its own module runner, so the Jest ESM/CommonJS
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
      resolve: {
         alias: [
            { find: /^vscode-jsonrpc\/browser$/, replacement: jsonrpcBrowser },
            { find: /^vscode-languageserver\/browser$/, replacement: languageServerNode }
         ]
      },
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
