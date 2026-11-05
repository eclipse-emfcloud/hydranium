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
 * scope changed). A project a document other than its descriptor changed
 * is reported as {@link updated} in an event of its own, once a build
 * completes.
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
 *   which the build of the update that changed the project picks up.
 *   Empty when the project manager relinks them in a follow-up build of its
 *   own instead (`ProjectManagerOptions.deferMemberRelink`). That build
 *   emits an event of its own, with no project in it, carrying the members
 *   it resets.
 *   Consumers can subscribe independently for other reactions.
 */
export interface ProjectChangeEvent<TProject extends Project = Project> {
   /** Ids of projects newly registered since the last event. */
   readonly added: readonly string[];

   /**
    * Ids of projects re-parsed from a changed descriptor that kept the same
    * id. A descriptor that now names a *different* id is reported as a
    * removal of the old id plus an addition of the new one, never here.
    * Projects that `AbstractProjectManager.projectsAffectedBy` names are
    * reported in an event of their own, once a build completes.
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
    * `AbstractProjectManager.getAffectedProjects`). In the event a deferred
    * relink emits, the members it resets.
    *
    * The descriptors that triggered this cycle are excluded, since re-adding
    * them would loop. Any other descriptor of an affected project is a member.
    */
   readonly affectedDocuments: readonly URI[];
}

/** Callback shape for `ProjectManager.onProjectsChanged`. */
export type ProjectChangeListener<TProject extends Project = Project> = (event: ProjectChangeEvent<TProject>) => void;

/** Callback shape for `ProjectManager.onMemberRelinkStarted`: the documents the follow-up build relinks. */
export type MemberRelinkStartedListener = (documents: readonly URI[]) => void;

/** What `ProjectManager.onMemberRelinkFinished` tells a listener. */
export interface MemberRelinkFinishedEvent {
   /**
    * `false` when the follow-up build was cancelled or failed. A cancelled
    * one is queued again, and another started and finished pair follows only
    * if members are left, since the cancelling write may build them all.
    * Await `ProjectManager.memberRelinkSettled` to learn the relink is done.
    */
   readonly completed: boolean;
}

/** Callback shape for `ProjectManager.onMemberRelinkFinished`. */
export type MemberRelinkFinishedListener = (event: MemberRelinkFinishedEvent) => void;
