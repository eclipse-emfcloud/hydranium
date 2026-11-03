/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import { definePackageVitestConfig } from '../../../vitest.shared.ts';

const config = mergeConfig(definePackageVitestConfig('guidance-console'), {
   root: fileURLToPath(new URL('.', import.meta.url)),
   test: { include: ['console.fixture.ts'] }
});

// mergeConfig concatenates arrays; this deliberate failure must never publish
// the shared configuration's JUnit results into a successful CI run.
export default { ...config, test: { ...config.test, reporters: ['default'] } };
