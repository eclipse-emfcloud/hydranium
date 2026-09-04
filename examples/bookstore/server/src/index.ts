/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Public surface of the Bookstore language server: the DI factory, the generated
// AST, and the headless `createServices` entry.
//
// The entry points under `src/` are deliberately NOT re-exported. Each opens a
// transport at module scope, so importing one starts a server as a side effect
// — which is why they are `bin` targets and this file is `main`.

export * from './language-server/bookstore-module.js';
export * from './language-server/ast.js';
export { createServices } from './services.js';
export * from './head-ports.js';
