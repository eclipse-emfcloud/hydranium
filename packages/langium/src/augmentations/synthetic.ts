/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Augments Langium's {@link AstNode} with a `$synthetic` marker —
 * `true` when the node was programmatically constructed rather than
 * parsed from source.
 *
 * This is a pure, ambient type-level merge: it widens the canonical
 * `langium` `AstNode` interface so the marker is visible on every
 * AST-derived type (generated subtypes, `$container` hops, `AstUtils`
 * return types) regardless of import path. It carries no runtime code.
 * The behaviour-bearing side of the synthetic concept — `markSynthetic`
 * / `markSyntheticTree` / `isSyntheticNode` and the validation-skip
 * default that reads them — lives in `@hydranium/core`; this package
 * owns only the type widening.
 *
 * Adopters may further narrow this on grammar-specific AST types to give
 * synthetic mirrors a literal-type compile-time hint at construction
 * sites.
 */
declare module 'langium' {
   interface AstNode {
      /**
       * Marks the node as synthetic — programmatically constructed, not
       * parsed from source. Synthetic nodes are skipped during validation
       * by default, via `HydraniumDocumentValidator.shouldSkipValidation`.
       */
      readonly $synthetic?: boolean;
   }
}
