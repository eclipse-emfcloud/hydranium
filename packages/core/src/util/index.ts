/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export * from './connection-liveness.js';
export * from './environment.js';
export * from './registry.js';
// Side-effect import: the `UriUtils` namespace augmentation
// (`UriUtils.toUri` / `.isAncestorOrEqual`) lives in the langium chokepoint.
// Pulling it in here keeps it loaded for any consumer importing from
// `@hydranium/core/util`, and the chokepoint also loads it whenever any
// `@hydranium/langium` symbol is imported.
import '@hydranium/langium';
