/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Strips types with esbuild. `ts-jest` drives the TypeScript compiler API, which
 * TypeScript 7 does not ship; `typecheck:test` type-checks these files instead.
 */
const { transformSync } = require('esbuild');

module.exports = {
   process(source, filename) {
      const { code, map } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: true, sourcefile: filename });
      return { code, map };
   }
};
