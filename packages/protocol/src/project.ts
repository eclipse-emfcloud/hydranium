/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Cross-cutting domain type for the project tier — a descriptor-discovered,
 * optionally versioned and dependency-aware sub-grouping of model files
 * inside an LSP workspace folder.
 *
 * Owned by `@hydranium/protocol` (rather than `@hydranium/core`) so
 * protocol consumers — including browser-bundle frontend code that
 * imports the typed data-server proxy — pull this type without
 * transitively depending on Langium. The `Project` shape is the structural
 * baseline both the framework's runtime project tier (`ProjectManager` in
 * `@hydranium/core`) and its wire-level surface (`DataServerProtocol`
 * methods returning projects) agree on; collapsing them into one
 * type eliminates a duplicate definition that would otherwise drift.
 *
 * **Project tier rationale.** Sits at a tier Langium itself deliberately
 * does not provide. Langium's `WorkspaceManager` indexes all files in all
 * workspace folders into one flat global scope; the maintainers have
 * on-record stated they intend to keep it that way — see
 * [Discussion #1375 — *Multiple Languages from different Projects*](https://github.com/eclipse-langium/langium/discussions/1375).
 * This framework fills that gap so consumers don't have to reinvent it.
 * Consumers that don't need projects bind `SingleProjectManager` and pay
 * no cost — one synthetic project at runtime, no descriptor tracking,
 * no events.
 *
 * **Extension model.** Adopters with richer per-project metadata declare a
 * subtype `interface MyProject extends Project { ... }` and parameterise
 * `ProjectManager<MyProject>` / `DataServer<TRoot, TDiagnostic, MyProject>`.
 * The framework's structural read from a project is `id` (registry key,
 * dependency-graph identity) plus optionally `dependencies` (visibility-
 * closure walk); every other field is either wire metadata (`version`) or
 * adopter-specific extension carried transparently through the typed
 * surface. The framework imposes no format on extension fields — they
 * ride on the JSON-RPC envelope as additional properties when crossing
 * the wire.
 */
export interface Project {
   /**
    * Stable, unique identifier. Used as the lookup key in
    * `ProjectManager.getProjectById` and as the value in
    * {@link dependencies} entries that point at this project.
    * Conventionally a name-plus-version string (e.g.
    * `"example-dwh@1.0.0"`), but the framework imposes no format — any
    * non-empty string works.
    *
    * The framework's internal identifier — map keys, visibility-set
    * membership, dependency-declaration matching. Distinct from the
    * user-facing {@link referenceName}; see there for why they are separate.
    */
   readonly id: string;

   /**
    * User-facing prefix used in qualified-name references that cross
    * project boundaries. Composed by `NameProvider.getProjectQualifiedName`
    * to produce the workspace-unique form that the linker resolves
    * cross-project references against; emitted as the name of the
    * `TieredAstNodeDescription` produced by
    * `HydraniumScopeComputation.addExportedSymbol` when the project-
    * qualified form differs from the document-qualified form.
    *
    * Set to {@link UNQUALIFIED_PROJECT_REFERENCE} (`''`) to contribute no
    * prefix at all — see that constant for the semantics.
    *
    * **Why this is a separate field from {@link id}.** Two reasons:
    *  1. Versioned ids (e.g. `"example-dwh@1.0.0"`) need un-versioned
    *     names in reference syntax (`example-dwh.User.email`) — the
    *     version pinning only matters for dependency declarations.
    *  2. Names with grammar-illegal characters (dots, spaces) need
    *     sanitisation. The framework cannot safely sanitise {@link id}
    *     (it would break dependency matching); a separate field lets
    *     adopters sanitise once at parse time.
    */
   readonly referenceName: string;

   /**
    * Optional semantic version of the project. Distinct from {@link id}
    * because two versions of the same logical project are different
    * projects (different {@link id}s) — `version` is metadata for tooling /
    * display / version-matched dependency declarations, not part of
    * identity. The framework does not read this field internally; it
    * passes through to clients as-is.
    */
   readonly version?: string;

   /**
    * Ids of other projects this project explicitly depends on. Concrete
    * `ProjectManager` implementations decide what "depends on" means
    * and combine these into the visibility closure via
    * `ProjectManager.getVisibleProjects` — the framework default in
    * `AbstractProjectManager` walks them transitively; adopters can
    * override.
    */
   readonly dependencies?: readonly string[];
}

/**
 * Sentinel value for {@link Project.referenceName} indicating the
 * project does not prefix its names with a reference segment. Names
 * from such projects contribute to the workspace-wide namespace as-is —
 * `NameProvider.getProjectQualifiedName` collapses to
 * `getDocumentQualifiedName`, and `HydraniumScopeComputation` emits a
 * single description per node (no separate `tier: 'public'` entry,
 * since it would carry the same name).
 *
 * Typical use:
 * - `SingleProjectManager` workspaces (no inter-project disambiguation
 *   needed — there is only one project, the synthetic workspace project).
 * - Adopters whose grammar has no qualified-name reference syntax (e.g.
 *   class references written as bare `[Class:ID]` tokens at the framework
 *   boundary; per-package projects all bind this sentinel).
 *
 * The empty string is chosen so that `referenceName + nameSeparator + name`
 * compositions detect the unqualified case without an explicit null
 * check on the consumer side — but for predicate readability prefer
 * `ProjectManager.isUnqualifiedProjectReference(uri)`.
 */
export const UNQUALIFIED_PROJECT_REFERENCE = '';
