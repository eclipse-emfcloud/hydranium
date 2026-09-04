/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { definePackageVitestConfig } from '../../vitest.shared';

// `test/jest/**` holds the one Jest-run smoke that exercises the shipped
// `@hydranium/conformance/jest` adapter (run by this package's own Jest config),
// so Vitest must leave it to Jest.
export default definePackageVitestConfig('conformance', { exclude: ['test/jest/**'] });
