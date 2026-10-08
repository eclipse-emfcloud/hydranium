/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The VS Code build both VS Code tiers download and run.
 *
 * Pinned rather than `stable`, so a VS Code release cannot turn a run red with
 * no change in this repository, and the Playwright tier's workbench selectors
 * move only when this does. Bump it on purpose and run both tiers.
 */
export const VSCODE_VERSION = '1.141.0';
