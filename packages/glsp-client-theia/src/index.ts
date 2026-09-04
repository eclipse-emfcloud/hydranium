/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Root barrel re-exports the browser-side surface, mirroring the root entry of
// the package this one integrates: `@eclipse-glsp/theia-integration`'s own
// `main` is its browser tier, so an adopter importing the bare specifier
// expects the same surface here.
//
// That makes this root BROWSER-BOUND, not neutral, and not merely
// DOM-avoiding: the re-exported tier value-imports `@theia/workspace`'s and
// `@theia/output`'s browser modules, which touch `document` at module load, and
// its dependency graph imports stylesheets, so loading it needs a bundler with a
// CSS loader. It is a frontend entry and nothing else. Node-side primitives
// (connection-handler wiring) stay behind
// `@hydranium/glsp-client-theia/node` so the `@theia/core/lib/node/...`
// imports don't leak into a browser bundle.
export * from './browser/index';
