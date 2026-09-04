/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Project, type Tracer, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import { type AstNode, type LangiumDocuments, type URI } from '@hydranium/langium';
import { Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import type { ProjectChangeListener } from './project-change-event.js';
import type { ProjectManager } from './project-manager.js';

/**
 * Framework default {@link ProjectManager}. Exposes a single synthetic
 * project ({@link SingleProjectManager.WORKSPACE_PROJECT_ID}) that owns
 * every document in the workspace, so visibility queries answer
 * **"everything is visible to everything"** — preserving Langium's
 * default flat-scope behaviour.
 *
 * The class name describes the state literally: one project. Consumers
 * without a project tier (tests / single-grammar adopters) bind
 * this and pay zero cost. No descriptor tracking, no incremental work,
 * no events ever fire from {@link onProjectsChanged}.
 *
 * For project-aware consumers, extend `AbstractProjectManager` instead.
 */
export class SingleProjectManager implements ProjectManager {
   /**
    * Identity of the synthetic project. Prefixed with `@` so it cannot
    * collide with a descriptor-derived project id, which by convention
    * never begins with `@`.
    */
   static readonly WORKSPACE_PROJECT_ID = '@workspace';

   protected readonly project: Project = {
      id: SingleProjectManager.WORKSPACE_PROJECT_ID,
      referenceName: UNQUALIFIED_PROJECT_REFERENCE
   };
   readonly ready = Promise.resolve();

   protected readonly langiumDocuments: LangiumDocuments;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: LogNameOptions = {}
   ) {
      this.langiumDocuments = services.workspace.LangiumDocuments;
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   /** No-op: there are no descriptors to discover. */
   async discoverProjects(): Promise<void> {
      // no-op
   }

   /** Never fires — `SingleProjectManager` exposes a fixed registry. The returned disposable is a safe no-op. */
   onProjectsChanged(_listener: ProjectChangeListener): Disposable {
      return Disposable.create(() => undefined);
   }

   isProjectDescriptor(_uri: URI | string): boolean {
      return false;
   }

   /** Always `true` — single-project by definition. */
   isSingleProject(): boolean {
      return true;
   }

   /**
    * Always `true` — the synthetic workspace project is constructed with
    * {@link UNQUALIFIED_PROJECT_REFERENCE}, so every URI it owns is by
    * definition unqualified.
    */
   isUnqualifiedProjectReference(_uri: URI | string): boolean {
      return true;
   }

   /** Every URI belongs to the synthetic workspace project. */
   getProject(_uri: URI | string): Project | undefined {
      return this.project;
   }

   /** Every node belongs to the synthetic workspace project. */
   getProjectForNode(_node: AstNode): Project | undefined {
      return this.project;
   }

   getProjectById(id: string): Project | undefined {
      return id === SingleProjectManager.WORKSPACE_PROJECT_ID ? this.project : undefined;
   }

   getProjects(): readonly Project[] {
      return [this.project];
   }

   /** All workspace URIs belong to the synthetic project; any other id yields `[]`. */
   getProjectUris(projectId: string): readonly URI[] {
      if (projectId !== SingleProjectManager.WORKSPACE_PROJECT_ID) {
         return [];
      }
      return Array.from(this.langiumDocuments.all, document => document.uri);
   }

   /** Self-only visibility, combined with single-project ownership = "everything sees everything." */
   getVisibleProjects(projectId: string): readonly string[] {
      return projectId === SingleProjectManager.WORKSPACE_PROJECT_ID ? [SingleProjectManager.WORKSPACE_PROJECT_ID] : [];
   }

   /** Synthetic project sees itself iff `selfVisible`; cross-project queries always false. */
   isVisible(sourceProjectId: string, targetProjectId: string, selfVisible = false): boolean {
      if (sourceProjectId !== SingleProjectManager.WORKSPACE_PROJECT_ID) {
         return false;
      }
      if (sourceProjectId === targetProjectId) {
         return selfVisible;
      }
      return false;
   }
}
