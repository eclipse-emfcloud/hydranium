/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Public API barrel for `@hydranium/data-server` — the typed-RPC
// protocol head. Test-only helpers (duplex-connection pair, ...) live
// under the `./testing` subpath and are NOT re-exported here so
// production bundles stay free of test scaffolding.
export * from './data-server.js';
export * from './diagnostics-provider.js';
