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
// with an empty module. The prebundle lands in `node_modules/.vite/vitest/`,
// which turbo neither hashes nor cleans; a damaged one fails every suite here
// with `Cannot find module …/deps_ssr/<dep>.js`, and `npm run clean` sweeps it.
export default mergeConfig(definePackageVitestConfig('glsp-client'), {
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
