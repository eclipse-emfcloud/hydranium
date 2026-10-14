/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// What the Bookstore server and its clients both import. A client depends on
// this package instead of the server, so it never installs Langium to reach a
// constant or a wire type.
//
// The server's `generate` writes `generated-hydranium/` from the grammar;
// commit those modules with the grammar change that produced them. An interface
// narrowed here hides the generated constant of the same name; re-export that
// constant beside it, and declare the type map under its own name with the
// narrowed entry, or the builder and the GLSP state keep the generated one.

export * from './generated-hydranium/languages.js';
export * from './generated-hydranium/transfer-model.js';
export * from './head-ports.js';
export * from './bookstore-diagram-types.js';
