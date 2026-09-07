/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, type Stream, stream } from '@hydranium/langium';
import { isTieredDescription } from './scoped-ast-node-description.js';

/**
 * Tier-sibling primitives — the building blocks for the "canonical
 * filter" that collapses the multiple descriptions a single AST node
 * emits across visibility tiers (multi-tier emission) down to the one
 * most-specific tier-sibling per node.
 *
 * Multi-tier emission means one node is exported under several
 * {@link AstNodeDescription}s — e.g. a `'project'`-tier short name and a
 * `'public'`-tier project-qualified name for the same node. Those
 * descriptions are *tier siblings*: same node, different tier. In a
 * resolution scope both may legitimately appear (so a reference resolves
 * by either form); in a completion dropdown only the canonical
 * (most-specific) sibling should be shown so the user sees one entry per
 * node.
 */

/**
 * True if two descriptions refer to the same AST node, regardless of
 * tier. Prefers node identity when both carry a live `node`; otherwise
 * falls back to the stable document-URI + path key.
 */
export function areTierSiblings(left: AstNodeDescription, right: AstNodeDescription): boolean {
   if (left.node !== undefined && left.node === right.node) {
      return true;
   }
   return left.documentUri.toString() === right.documentUri.toString() && left.path === right.path;
}

/**
 * Compare two descriptions by tier specificity. Returns a negative
 * number if `left` is more specific (should win), positive if `right`
 * is, `0` if equally specific. More specific = narrower visibility:
 * `local` < `project` < `public` < `universal`. Untiered descriptions
 * rank least specific so a tiered sibling always wins.
 */
export function compareTierSpecificity(left: AstNodeDescription, right: AstNodeDescription): number {
   return tierRank(left) - tierRank(right);
}

function tierRank(description: AstNodeDescription): number {
   if (!isTieredDescription(description)) {
      return Number.POSITIVE_INFINITY;
   }
   switch (description.tier) {
      case 'local':
         return 0;
      case 'project':
         return 1;
      case 'public':
         return 2;
      case 'universal':
         return 3;
   }
}

function nodeKey(description: AstNodeDescription): string {
   return `${description.documentUri.toString()}#${description.path}`;
}

/**
 * Canonical filter: group descriptions by AST node and keep the
 * most tier-specific sibling per group (see
 * {@link compareTierSpecificity}). Input order is otherwise preserved —
 * the first-seen sibling holds each group's slot and is only replaced by
 * a strictly more specific one, so a stable upstream order stays stable.
 */
export function dedupeTierSiblingsStream<T extends AstNodeDescription>(descriptions: Stream<T>): Stream<T> {
   const byNode = new Map<string, T>();
   for (const description of descriptions) {
      const key = nodeKey(description);
      const existing = byNode.get(key);
      if (existing === undefined || compareTierSpecificity(description, existing) < 0) {
         byNode.set(key, description);
      }
   }
   return stream(byNode.values());
}
