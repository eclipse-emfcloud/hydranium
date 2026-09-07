/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Project, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import { type AstNode, AstUtils, type URI, UriUtils } from '@hydranium/langium';
import { Disposable } from 'vscode-languageserver';
import type { WorkspaceFolder } from 'vscode-languageserver-types';
import type { ProjectChangeEvent, ProjectChangeListener } from '../langium/project/project-change-event.js';
import type { ProjectManager } from '../langium/project/project-manager.js';

/**
 * Stub for {@link ProjectManager}. Backed by a mutable `projects` array so
 * tests can rearrange the registry between assertions, with test-only
 * helpers:
 *
 * - {@link ownUri} — declare which project owns a given URI. Drives
 *   {@link getProject} lookups so tests can model multi-project workspaces
 *   without spinning up an `AbstractProjectManager`.
 * - {@link fireProjectsChanged} — synchronously deliver a synthetic
 *   {@link ProjectChangeEvent} to subscribers.
 *
 * `getProjectUris` / `getVisibleProjects` / `isVisible` answer from the
 * declared ownership and the projects' `dependencies`, matching what
 * `AbstractProjectManager` computes. `discoverProjects` and
 * `isProjectDescriptor` are inert defaults (no-op / always `false`);
 * override the returned object's methods for tests that need discovery
 * behaviour.
 */
export interface StubProjectManager<TProject extends Project = Project> extends ProjectManager<TProject> {
   /** Mutable project list; push / splice to model a changing registry. */
   readonly projects: TProject[];
   /** Declare which project owns the given URI for {@link getProject} lookups. */
   ownUri(uri: string | URI, projectId: string): void;
   /** Synchronously deliver a {@link ProjectChangeEvent} to every registered listener. */
   fireProjectsChanged(event: ProjectChangeEvent<TProject>): void;
   /** Drop ownership state, projects, and listeners. */
   reset(): void;
}

/** Build a {@link StubProjectManager}. Initial `projects` are pushed onto the mutable backing array. */
export function makeStubProjectManager<TProject extends Project = Project>(
   initialProjects: readonly TProject[] = []
): StubProjectManager<TProject> {
   const projects: TProject[] = [...initialProjects];
   const listeners: ProjectChangeListener<TProject>[] = [];
   const ownership = new Map<string, string>();

   return {
      get projects() {
         return projects;
      },
      ready: Promise.resolve(),
      async discoverProjects(_folders: readonly WorkspaceFolder[]): Promise<void> {
         // No-op default: the stub's registry is seeded directly. Tests that
         // exercise discovery semantics override this method or use a real
         // `AbstractProjectManager` subclass.
      },
      isProjectDescriptor(): boolean {
         return false;
      },
      isSingleProject(): boolean {
         return projects.length <= 1;
      },
      isUnqualifiedProjectReference(uri: URI | string) {
         const project = this.getProject(uri);
         return project === undefined || project.referenceName === UNQUALIFIED_PROJECT_REFERENCE;
      },
      getProjects() {
         return projects;
      },
      getProjectById(id: string) {
         return projects.find(project => project.id === id);
      },
      getProject(uri: URI | string) {
         const key = typeof uri === 'string' ? uri : uri.toString();
         const projectId = ownership.get(key);
         return projectId ? projects.find(project => project.id === projectId) : undefined;
      },
      getProjectForNode(node: AstNode) {
         const uri = AstUtils.findRootNode(node).$document?.uri;
         return uri ? this.getProject(uri) : undefined;
      },
      getProjectUris(projectId: string): readonly URI[] {
         // Registration gates the ownership scan, as in `AbstractProjectManager`:
         // an id no project carries owns nothing, whatever the ownership map
         // says. Without the gate a test could assert membership for a project
         // that was never registered.
         if (!projects.some(project => project.id === projectId)) {
            return [];
         }
         return [...ownership.entries()].filter(([, id]) => id === projectId).map(([uri]) => UriUtils.toUri(uri));
      },
      getVisibleProjects(projectId: string): readonly string[] {
         // Transitive closure of `Project.dependencies` including the source
         // — mirrors `AbstractProjectManager.getVisibleProjects` so tests
         // observe the same visibility model the production manager does.
         if (!projects.some(project => project.id === projectId)) {
            return [];
         }
         const visited = new Set<string>();
         const ordered: string[] = [];
         const walk = (id: string): void => {
            if (visited.has(id)) {
               return;
            }
            visited.add(id);
            const project = projects.find(p => p.id === id);
            if (!project) {
               return;
            }
            ordered.push(id);
            for (const dep of project.dependencies ?? []) {
               walk(dep);
            }
         };
         walk(projectId);
         return ordered;
      },
      isVisible(sourceProjectId: string, targetProjectId: string, selfVisible = false): boolean {
         // Same logic as AbstractProjectManager.isVisible — kept inline so the
         // stub stays self-contained.
         const visible = this.getVisibleProjects(sourceProjectId);
         if (visible.length === 0) {
            return false;
         }
         if (sourceProjectId === targetProjectId) {
            return selfVisible;
         }
         return visible.includes(targetProjectId);
      },
      onProjectsChanged(listener: ProjectChangeListener<TProject>) {
         listeners.push(listener);
         return Disposable.create(() => {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) {
               listeners.splice(idx, 1);
            }
         });
      },
      ownUri(uri, projectId) {
         const key = typeof uri === 'string' ? uri : uri.toString();
         ownership.set(key, projectId);
      },
      fireProjectsChanged(event) {
         for (const listener of listeners.slice()) {
            listener(event);
         }
      },
      reset() {
         projects.length = 0;
         listeners.length = 0;
         ownership.clear();
      }
   };
}
