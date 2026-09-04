/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The language's AST entry point: a re-export of what `langium generate`
// emits, plus anywhere you augment those types.
//
// Import the AST from HERE rather than from `./generated/ast.js`, so any
// augmentation below travels with every import. One `langium-cli` run over N
// grammars emits ONE combined AST module sharing one reflection, so a further
// grammar needs no change here.
//
// `generate:transfer-model` reads this file as its `--augmentation-file`: the
// generated wire types are derived from the AST *as augmented*, not from the
// raw generated module. Augment a type here and the transfer model follows.
//
// A `@derived` property is computed at build time rather than parsed, so it is
// declared here and populated by an AST-extension contribution:
//
// declare module './generated/ast.js' {
//    interface BookstoreModel {
//       /** @derived Populated by an `ast.extensions.computedProperties` contribution. */
//       readonly _summary?: string;
//    }
// }

export * from './generated/ast.js';
