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

export default mergeConfig(definePackageVitestConfig('guidance-console'), {
   root: fileURLToPath(new URL('.', import.meta.url)),
   test: { include: ['console.fixture.ts'], reporters: ['default'] }
});
