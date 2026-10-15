/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { fileURLToPath } from 'node:url';

/**
 * The VS Code build the smoke test downloads and runs. Pinned rather than
 * `stable`, so a VS Code release cannot fail a run with no change here.
 */
export const VSCODE_VERSION = '1.141.0';

/** Where `@vscode/test-electron` keeps the download, below this package. */
export const VSCODE_CACHE = fileURLToPath(new URL('../.vscode-test', import.meta.url));
