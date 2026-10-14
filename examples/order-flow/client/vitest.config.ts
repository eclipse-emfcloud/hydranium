/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import { definePackageVitestConfig } from '../../../vitest.shared';

// `@eclipse-glsp/client`'s built modules `require` CSS files, which Node would
// parse as JS once Vitest externalizes them. Pre-bundle the GLSP packages with
// every `.css` import replaced by an empty module, and alias
// `@hydranium/glsp-client` to its sources, whose ESM imports the optimizer
// serves; its CommonJS `lib` would `require` the stylesheet through Node. The
// prebundle is cached under `node_modules/.vite/vitest/`, which turbo neither
// hashes nor cleans; a damaged one fails every suite here with `Cannot find
// module …/deps_ssr/<dep>.js`, and `npm run clean` sweeps it.
//
// `@hydranium/data-client-vscode/browser` goes to its sources for the same
// reason: its `lib` `require`s `vscode-jsonrpc/browser`, which Node rejects and
// the shared alias reaches only through an import Vite serves.
const glspClientSrc = resolve(__dirname, '../../../packages/glsp-client/src');
const dataClientVscodeSrc = resolve(__dirname, '../../../packages/data-client-vscode/src');
export default mergeConfig(definePackageVitestConfig('order-flow-client'), {
   resolve: {
      alias: [
         { find: /^@hydranium\/glsp-client$/, replacement: resolve(glspClientSrc, 'index.ts') },
         { find: /^@hydranium\/data-client-vscode\/browser$/, replacement: resolve(dataClientVscodeSrc, 'browser/index.ts') }
      ]
   },
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
