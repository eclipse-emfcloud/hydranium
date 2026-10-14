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
// commit those modules with the grammar change that produced them.

export * from './generated-hydranium/languages.js';
export * from './generated-hydranium/transfer-model.js';
export * from './head-ports.js';
export * from './bookstore-diagram-types.js';
