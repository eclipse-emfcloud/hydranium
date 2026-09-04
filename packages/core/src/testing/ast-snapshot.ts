/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Structural AST snapshots for serializer round-trip testing.
 *
 * # The idea
 *
 * Byte-stability (the golden corpus) proves the serializer's *output format*
 * is pinned, but not that serialization *preserves meaning*. The complementary
 * guarantee is the round trip: parse some source, serialize the resulting
 * model back to text, parse that text again — the two models must be the same.
 * If they are, no semantic content was lost or invented in the trip through
 * text, independent of whitespace, member ordering, or dropped comments.
 *
 * # Why a snapshot, not the live AST
 *
 * You cannot `expect(ast2).toEqual(ast1)` on two live Langium ASTs:
 * - `$container` (and friends) make every node cyclic — a deep-equal walk
 *   never terminates.
 * - `$cstNode` carries source offsets that legitimately differ once text has
 *   been re-serialized and re-parsed, so it is noise for a semantic compare.
 * - a `Reference` holds a resolved `ref` back-pointer into the other tree;
 *   only its textual `$refText` is grammar content.
 *
 * {@link makeAstSnapshot} projects a node onto a plain, acyclic, JSON-like
 * value that keeps exactly the grammar-derived shape — node `$type`s, their
 * own properties, references reduced to `{ $refText }` — and drops the derived
 * placement/parse metadata and computed extensions. Two snapshots then compare
 * cleanly with `toEqual`, and that comparison means "same semantic model".
 */

import { isAstNode, isReference } from '@hydranium/langium';

/**
 * A plain, JSON-like structural view of an AST sub-tree — references reduced
 * to `{ $refText }`, every Langium-internal and computed-extension field
 * stripped. Cycle-free by construction, so it compares cleanly with
 * `expect(...).toEqual(...)`.
 */
export type AstSnapshot = unknown;

/**
 * Project an AST node (or any value reachable from one) onto a comparable
 * {@link AstSnapshot} that captures only the grammar-derived shape.
 *
 * Built for round-trip assertions: the snapshot of a model re-parsed from its
 * own serialized text deep-equals the snapshot of the original iff
 * serialization preserved the semantic model, independent of formatting (see
 * the module comment for why a snapshot is needed rather than a direct compare
 * of the live ASTs).
 *
 * What it keeps and what it drops:
 * - **`Reference`** (`$refText` + `ref`) → `{ $refText }`. The resolution
 *   target is positional noise; the textual name is the grammar content.
 * - **`$type`** is kept (it identifies the node); every other `$`-prefixed
 *   field (`$container`, `$containerProperty`, `$containerIndex`, `$cstNode`,
 *   `$document`, …) is dropped — all are derived placement/parse metadata.
 * - **`_`-prefixed fields** — the AST-extension computed properties — are
 *   dropped: they are derived at build time, not part of what a serializer
 *   round-trips.
 * - Arrays recurse element-wise; primitives pass through unchanged.
 */
export function makeAstSnapshot(value: unknown): AstSnapshot {
   if (isReference(value)) {
      return { $refText: value.$refText };
   }
   if (Array.isArray(value)) {
      return value.map(makeAstSnapshot);
   }
   if (isAstNode(value)) {
      const snapshot: Record<string, unknown> = { $type: value.$type };
      for (const [key, child] of Object.entries(value)) {
         if (key.startsWith('$') || key.startsWith('_')) {
            continue;
         }
         snapshot[key] = makeAstSnapshot(child);
      }
      return snapshot;
   }
   return value;
}
