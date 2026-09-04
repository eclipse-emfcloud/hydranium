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
// `@eclipse-glsp/theia-integration` is deliberately NOT in this list: pre-bundling
// it drags in Theia browser modules that touch DOM globals at load. Tests that
// need one of its exports mock the module instead.
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
