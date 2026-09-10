/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { mergeConfig } from 'vitest/config';
import { definePackageVitestConfig } from '../../vitest.shared';

// `@eclipse-glsp/client`'s built modules `require` CSS files. Vitest externalizes
// node_modules (loads them through Node untransformed), so Node would parse that
// CSS as JS. Pre-bundle the GLSP packages through Vitest's dep optimizer instead
// — paid once, then cached — and have the bundler replace every `.css` import
// with an empty module.
//
// **What "cached" costs, because the failure does not look like a cache.** The
// prebundle lands in `node_modules/.vite/vitest/<hash>/deps_ssr/`, which turbo
// neither hashes nor cleans, and which two concurrent vitest runs over this
// package share. A damaged one fails EVERY suite here with `Cannot find module
// …/deps_ssr/<dep>.js` — one prebundled chunk importing a sibling that is gone —
// and `TURBO_FORCE=true` re-runs the task without touching it. `npm run clean`
// sweeps it; see the root `//clean` note.
//
// **`@eclipse-glsp/theia-integration` is absent from this list, and importing one
// of its modules hits TWO blockers in sequence — which is worth stating, because
// clearing the first only reveals the second and reads like progress.**
//
// FIRST, a `.css` parsed as JavaScript (`Unexpected token '.'`). These packages
// are compiled CommonJS, and Vite's SSR runner cannot process CJS at ALL — such a
// dependency is always handed to Node, whatever this config says. Node then loads
// the stylesheet its `lib` requires and parses it as JS. Nothing on the Vite side
// intervenes, because externalization is transitive: once Node has a module,
// every `require` inside it is Node's too. Measured as no-ops, so they are not
// retried: adding this package (or the `@eclipse-glsp/client/lib` subpath) to the
// optimizer's `include`, `resolve.alias` emptying the CSS, and
// `server.deps.inline` — both as a pattern and as `true`.
//
// The stack blames `@eclipse-glsp/client/src/**/*.ts`, which is a SOURCE-MAPPED
// frame, not the file being loaded. The loaded file is the compiled `lib`
// sibling. Do not go looking for a resolution that reaches `src`; there is none.
//
// SECOND, once the CSS is neutralised — a `require.extensions['.css']` hook does
// work, being on Node's own path — the import reaches `@lumino/domutils`, which
// touches `document` at module scope and throws `document is not defined`. That
// is the wall, and getting past it needs a DOM environment, which no package
// here has: the shared base runs every suite under `environment: 'node'`.
//
// So a test needing one of this package's exports MOCKS the module.
export default mergeConfig(definePackageVitestConfig('glsp-client-theia'), {
   test: {
      deps: {
         optimizer: {
            ssr: {
               enabled: true,
               include: ['@eclipse-glsp/client', '@eclipse-glsp/sprotty', 'sprotty'],
               rolldownOptions: { moduleTypes: { '.css': 'empty' } }
            }
         }
      }
   }
});
