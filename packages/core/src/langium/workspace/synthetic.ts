/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Mutable } from '@hydranium/protocol';
import { type AstNode, AstUtils } from '@hydranium/langium';

// The `$synthetic` `AstNode` type augmentation lives in `@hydranium/langium`
// (the langium chokepoint); it arrives here ambiently via that dependency.
// This module owns the *behaviour* of the synthetic-node concept — the marker
// helpers below and the validation-skip default that reads them.
//
// This is the NODE-provenance axis: a synthetic node is one not authored by
// the user — synthesized in code (a stdlib element) or by projection (a mirror
// of an inherited member). It is distinct from the *document* axis, where a
// virtual document is one with no backing file. The two are orthogonal: a
// synthetic node can live in a real file, and a virtual document can hold
// non-synthetic nodes.

/**
 * Mark `node` as synthetic. Returns the node for fluent chaining.
 *
 * Opting into the synthetic marker drives behaviour changes downstream
 * — most notably, the framework's
 * `HydraniumDocumentValidator.shouldSkipValidation` default
 * skips marked nodes (unless `validateSyntheticNodes` is enabled),
 * short-circuiting validation for mirrors and stdlib content. Adopters
 * who want a synthetic node validated normally simply do not mark it.
 */
export function markSynthetic<T extends AstNode>(node: T): T {
   (node as Mutable<T>).$synthetic = true;
   return node;
}

/**
 * Walk an AST tree rooted at `root` and {@link markSynthetic mark}
 * every node. Use when building a stdlib / library document where
 * every node should opt into skip-validation semantics in one stroke.
 *
 * For partial marking (some nodes mirrored, some validated normally),
 * call {@link markSynthetic} on the specific nodes instead.
 */
export function markSyntheticTree(root: AstNode): void {
   for (const node of AstUtils.streamAst(root)) {
      markSynthetic(node);
   }
}

/**
 * True iff `node` has been explicitly marked synthetic via
 * {@link markSynthetic} / {@link markSyntheticTree}. The check is a
 * pure flag read — the URI scheme of the containing document does
 * not influence this predicate (see `isVirtualUri` for the separate
 * document-identity axis).
 */
export function isSyntheticNode(node: AstNode): boolean {
   return node.$synthetic === true;
}
