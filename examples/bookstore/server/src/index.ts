/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Public surface of the Bookstore language server: the DI factory and the
// generated AST, plus the diagram module.
//
// Everything here loads in a browser worker as well as in Node, so a host can
// compose the language wherever it runs it. `createServices`, which reads the
// real filesystem, is the package's `./node` entry instead. The entry points
// under `src/` are not re-exported either: each opens a transport at module
// scope, so importing one starts a server, which is why they are `bin` targets.

export * from './language-server/bookstore-module.js';
export * from './language-server/ast.js';
export * from './glsp/bookstore/diagram-module.js';
