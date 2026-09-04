/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Project } from '@hydranium/protocol';
import type { AstNode, URI } from '@hydranium/langium';
import type { Disposable } from 'vscode-languageserver';
import type { WorkspaceFolder } from 'vscode-languageserver-types';
import type { ProjectChangeListener } from './project-change-event.js';

/**
 * Manages the **project tier** sitting between the LSP `WorkspaceFolder`
 * (protocol-owned: URI + display name only) and `LangiumDocument`
 * (Langium-owned: per-file parse + index + state). Owns project discovery,
 * registry maintenance, and the cascade signal for documents whose
 * reachable scope changed when a project changed.
 *
 * Langium does not provide a project tier and explicitly does not intend
 * to add one — see [Discussion #1375 — *Multiple Languages from different
 * Projects*](https://github.com/eclipse-langium/langium/discussions/1375).
 * `@hydranium/core` provides this tier so consumers don't have to
 * reinvent it.
 *
 * ## Lifecycle
 *
 * 1. `HydraniumWorkspaceManager.performStartup` awaits {@link discoverProjects}
 *    as **phase 0**, before Langium's file-discovery and document-loading
 *    phases. By the time any non-descriptor document hits `Parsed`, the
 *    registry is fully populated and {@link getProject} returns a
 *    definitive answer.
 * 2. {@link ready} resolves at the end of phase 0. Code that depends on
 *    project membership during startup (AST extensions running at
 *    `IndexedContent`, integrity rules, scope providers) awaits this.
 * 3. After startup, the abstract `AbstractProjectManager` base auto-
 *    subscribes to `DocumentBuilder.onUpdate` to track incremental
 *    changes to descriptor files; each relevant update fires
 *    {@link onProjectsChanged} with the registry diff + affected
 *    documents, and `HydraniumWorkspaceManager` re-runs
 *    `DocumentBuilder.resetToState` on the affected URIs to cascade
 *    the rebuild.
 *
 * ## Implementations
 *
 * - **`SingleProjectManager`** — the framework default. One synthetic
 *   project owns every document, so visibility queries answer
 *   "everything sees everything" and consumers without a project tier
 *   pay zero cost.
 * - **`AbstractProjectManager`** — abstract base for project-aware
 *   consumers, carrying the registry, the `DocumentBuilder.onUpdate`
 *   subscription, the event channel, and the cascade computation.
 */
export interface ProjectManager<TProject extends Project = Project> {
   // ============================================================
   // Lifecycle
   // ============================================================

   /**
    * Phase-0 discovery. Called once during workspace startup, before any
    * non-descriptor documents are loaded. Implementations walk the given
    * workspace folders for descriptor files (whatever the consumer defines
    * as such via {@link isProjectDescriptor}), parse them, and populate the
    * registry. After this method resolves, {@link ready} resolves.
    *
    * Implementations may emit an initial {@link onProjectsChanged} with
    * `added` populated. The empty-registry case (no descriptors found) is
    * valid and emits nothing.
    */
   discoverProjects(folders: readonly WorkspaceFolder[]): Promise<void>;

   /**
    * Resolves at the end of {@link discoverProjects}.
    *
    * `SingleProjectManager` resolves this synchronously at construction
    * time — consumers can await it safely without triggering a hang when
    * no project tier is wired.
    */
   readonly ready: Promise<void>;

   /**
    * Subscribe to project add / update / remove events. Fires whenever
    * the registry changes — both during incremental rebuilds (descriptor
    * file edited / deleted) and as a single event at the end of
    * {@link discoverProjects} when projects were found.
    *
    * Returns a `Disposable` that unregisters the listener.
    */
   onProjectsChanged(listener: ProjectChangeListener<TProject>): Disposable;

   // ============================================================
   // Queries
   // ============================================================

   /**
    * The {@link Project} owning the given document URI, or `undefined` if
    * the URI does not belong to any project. Membership is determined by
    * the concrete implementation.
    *
    * `SingleProjectManager` always returns its synthetic workspace project —
    * never `undefined` — so consumers can rely on a non-null answer when
    * no project tier is wired (matches Langium's flat-scope default).
    */
   getProject(uri: URI | string): TProject | undefined;

   /**
    * The {@link Project} owning the document `node` belongs to, or `undefined`
    * (including when `node` is not attached to a document). Convenience over
    * {@link getProject} that centralizes the node→root-document→URI derivation
    * that callers would otherwise hand-roll (and risk skipping URI
    * normalization on). No `getProjectForDocument` sibling — `getProject(document.uri)`
    * is already a bare access, so a wrapper would hide nothing.
    */
   getProjectForNode(node: AstNode): TProject | undefined;

   /** Look up a project by its {@link Project.id}. */
   getProjectById(id: string): TProject | undefined;

   /** Snapshot of all projects currently in the registry. */
   getProjects(): readonly TProject[];

   /**
    * URIs of documents that belong to the given project. Returns an
    * empty array if the project id is unknown.
    */
   getProjectUris(projectId: string): readonly URI[];

   /**
    * Project ids visible from the given project: the project itself plus
    * the transitive closure of declared dependencies according to the
    * concrete implementation's visibility model. Returns an empty array
    * if the project id is unknown.
    *
    * Default behaviour in `AbstractProjectManager` is the **transitive
    * closure** of {@link Project.dependencies}, including the project
    * itself. An adopter can override to use a different visibility model.
    *
    * `SingleProjectManager` returns `[id]` for its synthetic workspace
    * project, which combined with "synthetic project owns every URI"
    * yields "everything is visible to everything" — Langium's flat-
    * scope behaviour preserved.
    */
   getVisibleProjects(projectId: string): readonly string[];

   /**
    * Convenience predicate over {@link getVisibleProjects}: returns true
    * iff `targetProjectId` is in the visibility set of `sourceProjectId`.
    * Unknown source ids (empty visibility set) always return false.
    *
    * @param selfVisible when `sourceProjectId === targetProjectId`,
    *        controls whether the project is considered visible to itself.
    *        Reference-construction callers pass `true` (a project sees
    *        its own elements); strict cross-project walks pass `false`.
    *        Default: `false`.
    *
    * **The `false` default is deliberate, and stays that way while the only
    * production caller passes `true`.** Flipping it to match that caller
    * would make a configure-time default out of a single hardcoded
    * argument — the same decision, written where the reader cannot see it.
    * Per-call explicitness keeps the *why* at the call site instead. Revisit
    * if a second non-test caller appears, or if an audit-strict caller
    * genuinely wants `false`.
    */
   isVisible(sourceProjectId: string, targetProjectId: string, selfVisible?: boolean): boolean;

   // ============================================================
   // Virtual hooks (consumer-implementable)
   // ============================================================

   /**
    * Fast-path predicate: true when the workspace has at most one
    * meaningful project boundary. Enables a fast-path in the framework's
    * `HydraniumScopeProvider.getProjectScope` that returns the
    * unfiltered global scope when project filtering would be a no-op.
    *
    * Default implementations:
    * - `SingleProjectManager`: returns `true` unconditionally (its
    *   synthetic workspace project owns everything).
    * - `AbstractProjectManager`: returns `getProjects().length <= 1`
    *   (conservative — once a second project is registered, returns
    *   false even if all documents are still owned by the original).
    *
    * Adopters with custom `ProjectManager` implementations override to
    * match their workspace shape.
    */
   isSingleProject(): boolean;

   /**
    * Predicate: is the given URI a project descriptor file?
    *
    * Determines which URIs participate in project discovery (during
    * {@link discoverProjects}) and incremental tracking (via the
    * auto-subscription to `DocumentBuilder.onUpdate` inside
    * `AbstractProjectManager`).
    *
    * Default in `SingleProjectManager`: returns `false`. Single-project /
    * project-less consumers get the default and never participate in
    * descriptor tracking.
    */
   isProjectDescriptor(uri: URI | string): boolean;

   /**
    * Whether the project owning `uri` uses unqualified references — i.e.
    * its {@link Project.referenceName} equals the
    * `UNQUALIFIED_PROJECT_REFERENCE` sentinel, or `uri` is not owned by
    * any project. The predicate exists so callers that would otherwise
    * compose a project prefix can skip the composition without reaching
    * for the sentinel value themselves; an implementation that can answer
    * without a full membership lookup overrides it.
    *
    * Default implementations:
    * - `SingleProjectManager`: always `true` — its synthetic workspace
    *   project is constructed with the sentinel.
    * - `AbstractProjectManager`: the owning project is absent, or its
    *   `referenceName` is the sentinel.
    */
   isUnqualifiedProjectReference(uri: URI | string): boolean;
}
