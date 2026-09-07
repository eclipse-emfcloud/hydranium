/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, AstUtils } from '@hydranium/langium';

/**
 * Element-key service — produces a string **handle** that round-trips to an
 * AST node *within a document*. Its consumer is the GLSP head, which keys its
 * GModel index by the result so UI state (selection, focus, expansion, scroll
 * position) survives the AST rebuilds triggered by user edits.
 *
 * # Why "key", not "id"
 *
 * A key is a lookup token, not a unique id: under the default name-based
 * strategy it is **neither unique nor rename-stable**, and it is allowed to
 * collide — collisions are resolved by the consumer's index, in
 * `HydraniumGlspIndex`'s duplicate-prune. The honest mental model is a *node
 * locator*, scoped to a single document; the positional strategy below
 * literally IS Langium's `AstNodeLocator` path. Reserve "id" for values that
 * are genuinely unique and stable (`Project.id`); this is not one.
 *
 * Distinct from `NameProvider`,
 * which produces the user-facing names used in reference syntax, completion
 * and search — non-unique and rename-sensitive. The two axes are separate
 * services so an adopter can override the one it needs; the locator role is
 * general (selection persistence, cross-session bookmarks, structural
 * diffing), not specific to the GLSP head that consumes it.
 *
 * # Two ready-to-use strategies
 *
 * The framework ships two concrete implementations; pick at the binding line
 * based on how the adopter's users interact with the model. Each class
 * documents its own stability profile.
 *
 * 1. **`NameBasedKeyProvider`
 *    (default)** — segments are names, so keys survive sibling reorder and
 *    mid-array insert / delete but flip on rename. **Why it is the default:
 *    interactive editing is the flagship use case, and reorder/insert/delete
 *    dominate that workload.** Forward-only — its inverse needs a subtree
 *    scan (see {@link resolveElement}).
 *
 * 2. **`PositionalKeyProvider`** —
 *    segments are positions, so keys are unique within the document,
 *    self-resolving and rename-stable, but flip whenever a `$containerIndex`
 *    shifts.
 *
 * # Other strategies adopters can plug in
 *
 * 1. **Source-persisted UUIDs** — extend the grammar with a hidden id
 *    field per node, generate fresh UUIDs in create-handlers, preserve
 *    them through serialisation. Truly stable across all mutations
 *    including renames; supports cross-session bookmarks. Cost: source
 *    files carry visible bookkeeping ids; serializer must round-trip
 *    them; create-handlers must generate them.
 *
 * 2. **Cross-rebuild heuristic matcher** — allocate opaque keys on first
 *    indexing; on rebuild, diff old vs new AST and preserve keys for
 *    structurally-matched node pairs. Best-effort full stability with
 *    no source-file impact. Substantial implementation.
 *
 * Adopters select a strategy by binding `references.ElementKeyProvider` in
 * their language module.
 */
export interface ElementKeyProvider {
   /**
    * The key for `node` within its document, or `undefined` for `undefined`
    * input and for a node the strategy cannot key.
    */
   getElementKey(node?: AstNode): string | undefined;

   /**
    * The inverse of {@link getElementKey} within a scope: the node in
    * `context`'s tree whose key equals `key`, or `undefined`.
    *
    * `context` is **any node** belonging to the tree the key was minted in —
    * it defines the *resolution scope*, not a position. Each strategy reads it
    * as its own uniqueness scope: the positional strategy resolves against
    * `context`'s document root (its keys are document-absolute); the
    * name-based strategy scans `context`'s subtree (its keys are
    * semantic-root-relative). Pass a document's root for whole-document
    * resolution, or a semantic root to narrow to one diagram.
    *
    * Keys are not guaranteed unique under the name-based default, so this is a
    * round-trippability contract, **not** a uniqueness guarantee: when two
    * nodes in scope share a key it returns the first (document-order) match.
    * The conformance law — for any node `n` under a scope root `r`,
    * `resolveElement(getElementKey(n), r) === n` — therefore holds for every
    * node iff keys are unique within `r`, which is exactly the invariant an
    * adopter's duplicate-name validation is responsible for.
    */
   resolveElement(key: string, context: AstNode): AstNode | undefined;
}

/**
 * Shared default for {@link ElementKeyProvider.resolveElement}: scan the
 * subtree rooted at `context` (including `context` itself) and return the
 * first node whose {@link ElementKeyProvider.getElementKey} equals `key`.
 * Used by the name-based strategy, which has no structural inverse; the
 * positional strategy overrides with the cheaper `AstNodeLocator.getAstNode`.
 * Scans `context`'s subtree — not the whole document — so a semantic-root
 * `context` narrows resolution to one scope.
 */
export function resolveElementByScan(keyOf: (node: AstNode) => string | undefined, key: string, context: AstNode): AstNode | undefined {
   if (keyOf(context) === key) {
      return context;
   }
   return AstUtils.streamAllContents(context).find(node => keyOf(node) === key);
}
