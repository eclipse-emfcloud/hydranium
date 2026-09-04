/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Server-only surface of the data head (`@hydranium/data-server/node`).
//
// The rule is the same one `@hydranium/core` follows: `.` is portable and
// bundles for a browser, everything that needs a Node runtime lives here. Adding
// a module to this directory is how a Node-only capability reaches the head
// without costing the portable entry its neutrality.

export * from './node-diagnostics-provider.js';
