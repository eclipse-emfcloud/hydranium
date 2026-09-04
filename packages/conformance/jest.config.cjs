/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Self-contained Jest config for the ONE smoke that exercises the shipped
 * `@hydranium/conformance/jest` adapter, so the Jest binding cannot rot while
 * Vitest owns every other test in this package (see `vitest.config.ts`, which
 * excludes `test/jest/**`). Scoped to `test/jest` so the two runners never
 * collide.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
   preset: 'ts-jest',
   testEnvironment: 'node',
   displayName: 'conformance-jest-smoke',
   roots: ['<rootDir>/test/jest'],
   extensionsToTreatAsEsm: ['.ts'],
   moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1'
   },
   transform: {
      '^.+\\.tsx?$': [
         'ts-jest',
         {
            useESM: true,
            tsconfig: '<rootDir>/tsconfig.test.json'
         }
      ]
   }
};
