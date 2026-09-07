/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNodeDescription } from '@hydranium/langium';

/**
 * Visibility tier of a {@link TieredAstNodeDescription} — the static
 * metadata declaring intended visibility class for each description.
 *
 * Tier is orthogonal to "scope" (the source-conditioned, tier-aware
 * projection of the global index at a query site, built by the scope
 * providers via filter rules over tiers). Tier is a per-description
 * label; scope is a per-query result.
 *
 * Four values:
 * - `'local'` — document-only (not in the global index; lives in
 *   Langium's precomputed per-document scope).
 * - `'project'` — visible inside the owning project only (equality
 *   check against the source's project id).
 * - `'public'` — visible from dependent projects only (own-project
 *   canonical filter + dependency-closure membership). The
 *   project-qualified public-tier sibling of a multi-tier emission.
 * - `'universal'` — visible everywhere unconditionally. Synthetic /
 *   library / stdlib content with no project ownership.
 */
export type DescriptionTier = 'local' | 'project' | 'public' | 'universal';

/**
 * A description that carries its visibility tier (and optional owning
 * project id) as typed fields. The framework's filter rules read these
 * fields directly to build per-query scopes without rediscovering
 * visibility via URI lookup on the hot path.
 *
 * The framework's `HydraniumScopeProvider.bucketFor`
 * reads `tier` directly when present and falls back to the URI-based
 * lookup for untagged descriptions, so adoption is incremental.
 */
export interface TieredAstNodeDescription extends AstNodeDescription {
   readonly tier: DescriptionTier;
   /**
    * Owning project id. Semantics vary by tier:
    *
    * - **`tier: 'project'`** — REQUIRED. Identifies the project that
    *   owns this description; visible iff `description.projectId ===
    *   sourceProjectId` (equality, not closure membership). Cross-
    *   project access via the `'public'`-tier sibling.
    *
    * - **`tier: 'public'`** — REQUIRED. Identifies the owning project of
    *   a multi-tier emission's public-tier sibling. The filter hides
    *   this description from queries originating inside its home
    *   project (the `'project'` sibling under a shorter name is the
    *   canonical entry there); visible from other projects iff
    *   `description.projectId` is in the source's dependency closure.
    *
    * - **`tier: 'universal'`** — FORBIDDEN. Universal descriptions have
    *   no owning project; visible everywhere unconditionally.
    *
    * - **`tier: 'local'`** — always absent. Local symbols don't pass
    *   through the project filter, so the field would be unused.
    *
    * Set this via the matching `HydraniumAstNodeDescriptionProvider`
    * factory method rather than constructing descriptions by hand — each
    * method enforces the correct shape at the type level.
    */
   readonly projectId?: string;
}

/**
 * Structural typeguard — true iff `description.tier` is set to a string.
 *
 * **Runtime value vs compile-time narrowing.** After the framework's
 * `HydraniumAstNodeDescriptionProvider.createDescription` override always
 * emits a `tier` field (defaulting to `'local'`), every description
 * produced inside the framework is already a `TieredAstNodeDescription`
 * at runtime — the predicate returns true for them unconditionally. The
 * load-bearing value of this function today is **TypeScript narrowing**:
 * it lifts an `AstNodeDescription` to `TieredAstNodeDescription` so call
 * sites that need to read `.tier` / `.projectId` don't have to cast.
 *
 * The runtime check is still required for descriptions that originate
 * outside the framework — third-party Langium services, fixtures, raw
 * `IndexManager.allElements` consumers — where the field may be absent.
 */
export function isTieredDescription(description: AstNodeDescription): description is TieredAstNodeDescription {
   return typeof (description as TieredAstNodeDescription).tier === 'string';
}

/**
 * True iff `description` is a {@link TieredAstNodeDescription} with
 * `tier === 'local'`. Use to filter / narrow at call sites that switch
 * on tier; equivalent to `isTieredDescription(d) && d.tier === 'local'`
 * with the type narrowing baked in.
 */
export function isLocalTier(description: AstNodeDescription): description is TieredAstNodeDescription & { readonly tier: 'local' } {
   return isTieredDescription(description) && description.tier === 'local';
}

/**
 * True iff `description` is a {@link TieredAstNodeDescription} with
 * `tier === 'project'`. Narrows `projectId` to non-nullable `string` —
 * matches the design contract that project-tier descriptions always
 * carry an owning project id.
 */
export function isProjectTier(
   description: AstNodeDescription
): description is TieredAstNodeDescription & { readonly tier: 'project'; readonly projectId: string } {
   return isTieredDescription(description) && description.tier === 'project';
}

/**
 * True iff `description` is the public-tier sibling of a multi-tier
 * emission — a {@link TieredAstNodeDescription} with `tier === 'public'`.
 *
 * `'public'` descriptions ALWAYS carry a `projectId` by construction
 * (the typed factory `createPublic` requires it). The framework's
 * `HydraniumScopeProvider.bucketFor` suppresses
 * a `'public'` description inside its owning project (so the shorter-
 * name `'project'`-tier sibling is the canonical entry there) and
 * shows it to dependent projects in the source's visibility closure.
 *
 * Use this typeguard at sites that iterate `IndexManager.allElements()`
 * and want to count each AST node exactly once — skip the public half
 * because the project-tier sibling already represents the node.
 */
export function isPublicTier(
   description: AstNodeDescription
): description is TieredAstNodeDescription & { readonly tier: 'public'; readonly projectId: string } {
   return isTieredDescription(description) && description.tier === 'public';
}

/**
 * True iff `description` is `tier === 'universal'` — synthetic /
 * library / stdlib content with no project ownership, visible
 * everywhere unconditionally.
 *
 * Universal descriptions never carry `projectId` (forbidden by the
 * factory `createUniversal`); the narrowed type omits the field.
 */
export function isUniversalTier(description: AstNodeDescription): description is TieredAstNodeDescription & { readonly tier: 'universal' } {
   return isTieredDescription(description) && description.tier === 'universal';
}

/**
 * Relational variant of {@link isPublicTier} — true iff the description
 * is a `'public'`-tier entry whose owning project is the given `projectId`.
 * Distinct from {@link isPublicTier} (which matches any public-tier
 * description, regardless of home).
 *
 * Used at adopter sites that pick the canonical entry for a given
 * source project: when iterating descriptions reachable from a source
 * URI's project, the public-tier sibling belonging to that
 * same project is redundant (the project-tier sibling under a shorter
 * name is already in scope) and should be hidden from completion /
 * linking. The framework's
 * `HydraniumScopeProvider.bucketFor` uses this
 * predicate to enforce the own-project canonical filter on the typed scope path.
 *
 * `projectId` accepts `string | undefined` for adopter-call-site
 * ergonomics: when the source has no resolvable project (standalone
 * document, no ProjectManager binding), the predicate returns `false`
 * for every description without forcing every caller to guard.
 */
export function isPublicFor(
   description: AstNodeDescription,
   projectId: string | undefined
): description is TieredAstNodeDescription & { readonly tier: 'public'; readonly projectId: string } {
   return projectId !== undefined && isPublicTier(description) && description.projectId === projectId;
}
