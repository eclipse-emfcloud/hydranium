/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Project } from '@hydranium/protocol';
import type { URI } from '@hydranium/langium';

/**
 * Event emitted by `ProjectManager.onProjectsChanged` when the project
 * registry diffs after a workspace update. Reports both the registry-level
 * diff (which projects appeared / changed / disappeared) and the document-
 * level fallout (which documents need to rebuild because their reachable
 * scope changed).
 *
 * - {@link added} / {@link updated} carry **project ids**, not {@link Project}
 *   objects. The full {@link Project} can be retrieved via
 *   `ProjectManager.getProjectById`.
 * - {@link removed} carries **{ id, snapshot }** pairs — by the time the event
 *   fires the registry has already cleared the project, so each entry bundles
 *   the id with the pre-removal snapshot so consumers can read the project's
 *   metadata (version, dependencies, plus any subclass-extended fields)
 *   without maintaining their own shadow registry.
 * - {@link affectedDocuments} lists URIs whose reachable scope changed. The
 *   default cascade plumbing in `HydraniumWorkspaceManager` subscribes to
 *   this event and re-runs `DocumentBuilder.resetToState` for each entry,
 *   which the next build cycle picks up. Consumers can subscribe
 *   independently for other reactions.
 */
export interface ProjectChangeEvent<TProject extends Project = Project> {
   /** Ids of projects newly registered since the last event. */
   readonly added: readonly string[];

   /**
    * Ids of projects re-parsed from a changed descriptor that kept the same
    * id. A descriptor that now names a *different* id is reported as a
    * removal of the old id plus an addition of the new one, never here.
    */
   readonly updated: readonly string[];

   /**
    * Projects no longer in the registry, paired with their pre-removal
    * snapshot. The id and snapshot are bundled per-entry so consumers
    * never need to zip parallel arrays by index.
    */
   readonly removed: ReadonlyArray<{ readonly id: string; readonly snapshot: TProject }>;

   /**
    * Documents whose reachable scope changed and therefore need to
    * rebuild. Includes the changed projects' own member documents plus
    * any transitive dependents according to the concrete
    * `ProjectManager`'s visibility model (see
    * `AbstractProjectManager.getAffectedProjects`).
    *
    * Descriptor URIs themselves are intentionally excluded: they triggered
    * this cycle and re-adding them would loop.
    */
   readonly affectedDocuments: readonly URI[];
}

/** Callback shape for `ProjectManager.onProjectsChanged`. */
export type ProjectChangeListener<TProject extends Project = Project> = (event: ProjectChangeEvent<TProject>) => void;
