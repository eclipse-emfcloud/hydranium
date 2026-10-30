/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred, type Project, type Tracer, UNQUALIFIED_PROJECT_REFERENCE, describeErrorWithStack } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   DocumentState,
   type FileSystemProvider,
   isOperationCancelled,
   type LangiumDocument,
   type LangiumDocuments,
   OperationCancelled,
   type URI,
   UriUtils,
   type WorkspaceLock
} from '@hydranium/langium';
import { CancellationToken, Disposable } from 'vscode-languageserver';
import type { WorkspaceFolder } from 'vscode-languageserver-types';
import type { LogNameOptions } from '../diagnostics/logger.js';
import { HYDRANIUM_BUILD_REASONS, type HydraniumDocumentBuilder } from '../document-builder/document-builder.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { isVirtualUri } from '../workspace/virtual-document.js';
import { releaseReadHolds, runOutsideReadLockScope } from '../workspace/lock-scope.js';
import type {
   MemberRelinkFinishedEvent,
   MemberRelinkFinishedListener,
   MemberRelinkStartedListener,
   ProjectChangeEvent,
   ProjectChangeListener
} from './project-change-event.js';
import type { ProjectManager } from './project-manager.js';

/** Constructor options for {@link AbstractProjectManager}. */
export interface ProjectManagerOptions extends LogNameOptions {
   /**
    * Relink the member documents a descriptor change affects in a build of
    * their own, queued once the build of the change has ended. The write that
    * changed the descriptor then answers without waiting for them, and they
    * keep the links they had until that build starts. An explicit
    * `DocumentBuilder.build`, such as workspace initialization, keeps them in
    * the build of the change, as without the option. Default `false`.
    *
    * A member already below its last phase stays in the build of the change,
    * which builds it anyway. That includes every member with a linking error,
    * which Langium relinks in every update. So a save that adds a dependency
    * still waits for the members it makes resolve.
    *
    * A write that lands while that build runs cancels it. The write's own
    * build then relinks the members still below `Validated`, since an update
    * builds every such document, and the next follow-up takes the rest. A
    * save made once that build has started therefore waits for part of the
    * relink. The follow-up is queued behind every write, so while writes keep
    * arriving, the members keep the links they had until the writes pause.
    *
    * A test or a teardown awaits {@link ProjectManager.memberRelinkSettled}
    * after a descriptor change, or the relink runs against a workspace already
    * removed.
    *
    * A member counts as relinked only once a build links it, so under
    * Langium's `eagerLinking: false`, which skips that phase, the follow-up
    * builds even a member a later write has built.
    */
   readonly deferMemberRelink?: boolean;
   /**
    * Which projects a project's references resolve against:
    * `'transitive'`, the default, is the closure of its
    * {@link Project.dependencies}, and `'direct'` only the projects it names.
    *
    * It decides visibility only. A change still rebuilds every project that
    * reaches the changed one through its dependencies, at any depth, since a
    * rebuild replaces the nodes their references point to, and a project two
    * steps away that is not relinked keeps references to the replaced nodes.
    */
   readonly visibility?: 'transitive' | 'direct';
}

/**
 * Abstract base for project-aware {@link ProjectManager} implementations.
 * Implements the machinery: registry, auto-subscription to
 * `DocumentBuilder.onUpdate`, event channel, cascade computation, and
 * change-emission.
 *
 * Consumers extend this and override only the hooks specific to their
 * project model. For the no-project case, bind `SingleProjectManager`
 * instead — it implements {@link ProjectManager} directly with a single
 * synthetic project that owns every URI.
 *
 * ## Required overrides
 *
 * - {@link isProjectDescriptor} — abstract; predicate identifying the
 *   consumer's descriptor files.
 * - {@link parseProjectDescriptor} — abstract; converts a parsed
 *   descriptor document into a {@link Project}.
 *
 * ## Optional overrides
 *
 * - {@link findDescriptorUris} — default walks the workspace folders
 *   recursively. Override to use a manifest index, glob pattern, or
 *   explicit listing.
 * - {@link shouldEnterDirectory} — default skips hidden directories,
 *   `node_modules`, and `out`. Override to customise exclusion rules
 *   without re-implementing the walk.
 * - {@link getAffectedProjects} — default walks {@link Project.dependencies}
 *   transitively in reverse (projects whose dep closure touches a changed
 *   project also rebuild). Override for a different rebuild policy.
 * - {@link getVisibleProjects} — default walks {@link Project.dependencies}
 *   as far as {@link ProjectManagerOptions.visibility} reaches. Override for
 *   a different visibility model.
 * - {@link shouldDeferMemberRelink} — default follows
 *   {@link ProjectManagerOptions.deferMemberRelink}. Override for a different
 *   choice of which builds leave the members to a follow-up build.
 * - {@link collectAffectedDocuments} — default collects the affected
 *   projects' members. Override to add documents a change affects otherwise.
 * - {@link computeProject} — default uses closest-ancestor-descriptor-folder
 *   membership. Override for a different membership model; overriding
 *   {@link getProject} instead loses the memoization it wraps.
 */
export abstract class AbstractProjectManager<TProject extends Project = Project> implements ProjectManager<TProject> {
   /** Project id → {@link Project}. */
   protected readonly projects = new Map<string, TProject>();

   /** Descriptor URI (`uri.toString()`) → project id. Drives {@link getProject} membership lookups. */
   protected readonly projectByDescriptor = new Map<string, string>();

   /** Descriptor URI → owning folder URI (cached for efficient closest-ancestor lookups). */
   protected readonly descriptorDirectories = new Map<string, URI>();

   /**
    * Memoized {@link getProject} results, keyed by URI string (`undefined` = no owning project,
    * distinguished from a cache miss by {@link Map.has}). Membership resolution is a hot path —
    * called per description / node / reference during a build — but the descriptor set only
    * changes on a project rebuild, so the result is stable between rebuilds. Cleared by
    * {@link invalidateMembershipCache} wherever the descriptor maps mutate.
    */
   protected readonly membershipCache = new Map<string, TProject | undefined>();

   protected readonly listeners: ProjectChangeListener<TProject>[] = [];
   protected readonly readyDeferred = new Deferred<void>();
   protected discoveryRan = false;

   protected readonly fileSystemProvider: FileSystemProvider;
   protected readonly langiumDocuments: LangiumDocuments;
   protected readonly documentBuilder: HydraniumDocumentBuilder;
   protected readonly workspaceLock: WorkspaceLock;
   protected readonly tracer: Tracer;
   /** Resolved from {@link ProjectManagerOptions.deferMemberRelink}. */
   protected readonly deferMemberRelink: boolean;
   /** Resolved from {@link ProjectManagerOptions.visibility}. */
   protected readonly visibility: 'transitive' | 'direct';

   /** Member documents a deferred relink has yet to take, by URI string. */
   protected readonly pendingMemberRelink = new Map<string, URI>();
   /** The keys of {@link pendingMemberRelink} to reset before they are built, whatever their state. */
   protected readonly pendingMemberResets = new Set<string>();
   /**
    * The keys of every queued or taken member that no build has relinked yet.
    * A member leaves once a build links it and then delivers its last phase
    * to every listener, whichever build that is: `Validated`, or
    * `IndexedReferences` when that build does not validate it.
    */
   protected readonly unrelinkedMembers = new Set<string>();
   /** The keys of {@link unrelinkedMembers} a build has linked since they were queued. */
   protected readonly linkedMembers = new Set<string>();
   /** Set from {@link queueMemberRelink} until {@link runMemberRelink} takes {@link pendingMemberRelink}. */
   protected memberRelinkQueued = false;
   /** Set once {@link registerMemberPhaseListeners} has run. */
   protected memberPhaseListenersRegistered = false;
   /** One per {@link runMemberRelink}, until it ends. */
   protected readonly memberRelinks = new Set<Promise<void>>();
   protected readonly memberRelinkStartedListeners = new Set<MemberRelinkStartedListener>();
   protected readonly memberRelinkFinishedListeners = new Set<MemberRelinkFinishedListener>();

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: ProjectManagerOptions = {}
   ) {
      this.fileSystemProvider = services.workspace.FileSystemProvider;
      this.langiumDocuments = services.workspace.LangiumDocuments;
      this.documentBuilder = services.workspace.DocumentBuilder;
      this.workspaceLock = services.workspace.WorkspaceLock;
      this.deferMemberRelink = options.deferMemberRelink ?? false;
      this.visibility = options.visibility ?? 'transitive';
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
      this.documentBuilder.onUpdate((changed, deleted) => this.onBuildUpdate(changed, deleted));
   }

   /**
    * Track members through every build from the first deferred relink on.
    * Registered then rather than here, so a manager that never defers adds no
    * listener to each document's phases.
    */
   protected registerMemberPhaseListeners(): void {
      this.memberPhaseListenersRegistered = true;
      this.documentBuilder.onDocumentPhase(DocumentState.Linked, document => this.onMemberLinked(document.uri));
      for (const phase of [DocumentState.IndexedReferences, DocumentState.Validated]) {
         this.documentBuilder.onDocumentPhaseDelivered(phase, document => {
            if (this.lastPhaseOf(document) === phase) {
               this.onMemberDelivered(document.uri);
            }
         });
      }
   }

   get ready(): Promise<void> {
      return this.readyDeferred.promise;
   }

   onProjectsChanged(listener: ProjectChangeListener<TProject>): Disposable {
      this.listeners.push(listener);
      return Disposable.create(() => {
         const idx = this.listeners.indexOf(listener);
         if (idx >= 0) {
            this.listeners.splice(idx, 1);
         }
      });
   }

   // ============================================================
   // Virtual hooks
   // ============================================================

   /**
    * Predicate: is the given URI a project descriptor file? **Abstract** —
    * concrete subclasses must implement, paired with their
    * {@link parseProjectDescriptor} override. The predicate gates both
    * initial discovery ({@link walkForDescriptors}) and incremental
    * tracking ({@link onBuildUpdate}); a default of `false` would
    * silently leave the manager idle even after the parser is wired,
    * so the predicate is required at the class level.
    *
    * Implementations are typically schema-driven — filename pattern,
    * extension, or location. Avoid registry lookups: new descriptors
    * appearing at runtime would not yet be in the registry.
    */
   abstract isProjectDescriptor(uri: URI | string): boolean;

   /**
    * Whether `uri` should be tracked as a project descriptor. Enforces the
    * framework invariant that a **virtual document** (no backing file, a
    * `virtual:` URI) can never be a descriptor — a contributed stdlib / library
    * document whose URI happens to match a broad adopter
    * {@link isProjectDescriptor} predicate must not spawn a phantom
    * project — then defers to the adopter predicate. Every descriptor gate
    * (initial walk + incremental {@link onBuildUpdate}) routes through here, so
    * the invariant holds for all adopters without each having to guard it.
    */
   protected isDescriptorUri(uri: URI | string): boolean {
      return !isVirtualUri(uri) && this.isProjectDescriptor(uri);
   }

   /**
    * Default implementation: `true` iff the owning project's
    * {@link Project.referenceName} equals {@link UNQUALIFIED_PROJECT_REFERENCE},
    * or `uri` is not owned by any project. Subclasses with cheaper
    * lookups override.
    */
   isUnqualifiedProjectReference(uri: URI | string): boolean {
      const project = this.getProject(uri);
      return project === undefined || project.referenceName === UNQUALIFIED_PROJECT_REFERENCE;
   }

   /**
    * Adopter-facing concept name used in the change-log lines this manager
    * emits ({@link logProjectChange}). Default `'project'`; adopters override
    * to their own domain term.
    */
   protected conceptName(): string {
      return 'project';
   }

   /**
    * Emit an `Add/Update` / `Remove` change-log line for a project. `uri` is the
    * descriptor file; its workspace-relative path is shown via the
    * `HydraniumWorkspaceManager` the framework binds. `info`-level, so it
    * is suppressed when the log threshold is above `info`.
    */
   protected logProjectChange(action: 'Add/Update' | 'Remove', id: string, uri: URI): void {
      const location = this.services.workspace.WorkspaceManager.wsRelativePath(uri);
      this.tracer.info(`${action} ${this.conceptName()} "${id}" from ${location}`);
   }

   /**
    * Default implementation: returns `true` while the registry holds at
    * most one project. Conservative — flips to `false` as soon as a
    * second project is registered, even if all documents still belong
    * to the first. Subclasses with a richer notion of "meaningful
    * project boundary" override.
    */
   isSingleProject(): boolean {
      return this.getProjects().length <= 1;
   }

   /**
    * Convert a parsed descriptor document into a {@link Project}, or
    * return `undefined` if the descriptor is malformed / incomplete.
    * Called from {@link loadDescriptor} during discovery and updates.
    *
    * Adopters populate {@link Project.referenceName} explicitly — empty
    * sentinel ({@link UNQUALIFIED_PROJECT_REFERENCE}) for projects that
    * do not qualify their names, or a sanitised / version-stripped form
    * for adopters with a custom reference scheme.
    */
   protected abstract parseProjectDescriptor(uri: URI, document: LangiumDocument): Promise<TProject | undefined>;

   /**
    * Locate descriptor URIs across the given workspace folders. Default
    * walks recursively via {@link fileSystemProvider}, respecting
    * {@link shouldEnterDirectory} for folder exclusions. Override to use
    * a manifest index, glob, or explicit listing.
    */
   protected async findDescriptorUris(folders: readonly WorkspaceFolder[]): Promise<URI[]> {
      const result: URI[] = [];
      for (const folder of folders) {
         await this.walkForDescriptors(UriUtils.toUri(folder.uri), result);
      }
      return result;
   }

   /**
    * Recursive helper for the default {@link findDescriptorUris}. Override
    * to customise traversal *behaviour*; override {@link shouldEnterDirectory}
    * if only the directory-exclusion rule needs to change.
    */
   protected async walkForDescriptors(folder: URI, accumulator: URI[]): Promise<void> {
      let entries;
      try {
         entries = await this.fileSystemProvider.readDirectory(folder);
      } catch (error) {
         this.tracer.warn(`Failed to read directory ${folder.toString()}: ${describeErrorWithStack(error)}`);
         return;
      }
      for (const entry of entries) {
         const name = UriUtils.basename(entry.uri);
         if (entry.isDirectory) {
            if (this.shouldEnterDirectory(entry.uri, name)) {
               await this.walkForDescriptors(entry.uri, accumulator);
            }
         } else if (entry.isFile && this.isDescriptorUri(entry.uri)) {
            accumulator.push(entry.uri);
         }
      }
   }

   /**
    * Predicate controlling whether the default descriptor walk descends
    * into a sub-directory. Default skips hidden directories
    * (`name.startsWith('.')`), `node_modules`, and `out` — the common
    * "ignore build outputs and tooling" rules. Override to tighten or
    * loosen the set without re-implementing the recursion.
    */
   protected shouldEnterDirectory(_uri: URI, name: string): boolean {
      if (name.startsWith('.')) {
         return false;
      }
      return name !== 'node_modules' && name !== 'out';
   }

   /**
    * Compute the set of projects whose member documents need to rebuild
    * given the directly changed projects. Default walks the dependency
    * graph in reverse — any project whose declared {@link Project.dependencies}
    * include a changed id transitively also rebuilds (cycle-safe), whatever
    * {@link visibility} is (see {@link ProjectManagerOptions.visibility}).
    *
    * Override for a different rebuild policy (custom reachability, etc.).
    */
   protected getAffectedProjects(directlyChanged: readonly string[]): readonly string[] {
      const result = new Set(directlyChanged);
      let grew = true;
      while (grew) {
         grew = false;
         for (const project of this.projects.values()) {
            if (result.has(project.id)) {
               continue;
            }
            if (project.dependencies?.some(dep => result.has(dep))) {
               result.add(project.id);
               grew = true;
            }
         }
      }
      return [...result];
   }

   /**
    * Whether replacing `previous` with `updated` — the same project re-parsed
    * (both carry the same {@link Project.id}) — forces the project's member
    * documents, and via {@link getAffectedProjects} its dependents, to
    * rebuild. Consulted only on the same-id update path; an id change is
    * handled as remove-old + add-new and always rebuilds.
    *
    * The default compares the fields the framework itself reads when building
    * or linking members: {@link Project.referenceName} (the prefix
    * cross-project qualified names resolve against) and
    * {@link Project.dependencies} (the visibility closure). It intentionally
    * ignores {@link Project.version} — the framework never reads it (it is
    * pass-through client metadata), so a version-only change still emits an
    * `updated` event but rebuilds nothing.
    *
    * Override to widen the comparison with adopter descriptor fields that a
    * member build observes, combining with `super.requiresMemberRebuild(...)`.
    */
   protected requiresMemberRebuild(previous: TProject, updated: TProject): boolean {
      return previous.referenceName !== updated.referenceName || !sameDependencies(previous, updated);
   }

   /**
    * Default: the source project itself, then the closure of its
    * {@link Project.dependencies}, or only the dependencies it names when
    * {@link visibility} is `'direct'`. A dependency that is not registered is
    * skipped. Override for a different visibility model.
    */
   getVisibleProjects(projectId: string): readonly string[] {
      const project = this.projects.get(projectId);
      if (!project) {
         return [];
      }
      if (this.visibility === 'direct') {
         return [...new Set([projectId, ...(project.dependencies ?? []).filter(dep => this.projects.has(dep))])];
      }
      const visited = new Set<string>();
      const ordered: string[] = [];
      this.collectVisibleProjects(projectId, visited, ordered);
      return ordered;
   }

   isVisible(sourceProjectId: string, targetProjectId: string, selfVisible = false): boolean {
      const visible = this.getVisibleProjects(sourceProjectId);
      if (visible.length === 0) {
         return false;
      }
      if (sourceProjectId === targetProjectId) {
         return selfVisible;
      }
      return visible.includes(targetProjectId);
   }

   protected collectVisibleProjects(projectId: string, visited: Set<string>, ordered: string[]): void {
      if (visited.has(projectId)) {
         return;
      }
      visited.add(projectId);
      const project = this.projects.get(projectId);
      if (!project) {
         return;
      }
      ordered.push(projectId);
      if (project.dependencies) {
         for (const dep of project.dependencies) {
            this.collectVisibleProjects(dep, visited, ordered);
         }
      }
   }

   // ============================================================
   // Discovery
   // ============================================================

   async discoverProjects(folders: readonly WorkspaceFolder[]): Promise<void> {
      if (this.discoveryRan) {
         this.tracer.warn('discoverProjects called more than once — ignoring subsequent call.');
         return;
      }
      this.discoveryRan = true;
      const descriptorUris = await this.findDescriptorUris(folders);
      const added: string[] = [];
      for (const uri of descriptorUris) {
         const project = await this.loadDescriptor(uri);
         if (project) {
            added.push(project.id);
         }
      }
      this.readyDeferred.resolve();
      if (added.length > 0) {
         this.emit({ added, updated: [], removed: [], affectedDocuments: [] });
      }
   }

   /**
    * Parse a single descriptor URI and register the resulting project.
    * Returns the parsed project, or `undefined` if parsing failed (errors
    * are logged, not thrown — the rest of discovery / update continues).
    */
   protected async loadDescriptor(uri: URI): Promise<TProject | undefined> {
      try {
         const document = await this.langiumDocuments.getOrCreateDocument(uri);
         if (document.state < DocumentState.Parsed) {
            // `onUpdate` fires before the build parses, so the AST is still the previous edit's.
            // The state is restored so the build still runs, and notifies, its own parse phase.
            const state = document.state;
            await this.services.workspace.LangiumDocumentFactory.update(document, CancellationToken.None);
            document.state = state;
         }
         const project = await this.parseProjectDescriptor(uri, document);
         if (project) {
            this.projects.set(project.id, project);
            this.projectByDescriptor.set(uri.toString(), project.id);
            this.descriptorDirectories.set(uri.toString(), UriUtils.dirname(uri));
            this.invalidateMembershipCache();
            this.logProjectChange('Add/Update', project.id, uri);
         }
         return project;
      } catch (error) {
         this.tracer.error(`Failed to parse ${this.conceptName()} descriptor at ${uri.toString()}: ${describeErrorWithStack(error)}`);
         return undefined;
      }
   }

   // ============================================================
   // Incremental update
   // ============================================================

   /**
    * Handle a `DocumentBuilder.onUpdate` event. Filters for descriptor
    * URIs, diffs the registry, and emits {@link ProjectChangeEvent} with
    * the registry diff plus the affected documents that need rebuilding.
    *
    * Descriptor URIs that triggered the cycle are excluded from
    * {@link ProjectChangeEvent.affectedDocuments} — re-adding them would
    * loop. When {@link shouldDeferMemberRelink} holds, the event carries only
    * the members already below their last phase, which this build builds
    * anyway, and the rest are queued for a follow-up build. The last phase
    * is the one of the build that last carried each member, since this
    * build's phases have not started yet. If validation was turned on since,
    * a member that build left at `IndexedReferences` is deferred, and this
    * build validates it before the follow-up relinks it.
    *
    * An override calls `super` before its first await, since
    * {@link shouldDeferMemberRelink} only answers for the calling build until
    * then.
    */
   protected async onBuildUpdate(changed: readonly URI[], deleted: readonly URI[]): Promise<void> {
      // Asked before the first await, while the builder still answers for
      // this call.
      const deferRelink = this.shouldDeferMemberRelink();
      const changedDescriptors = changed.filter(uri => this.isDescriptorUri(uri));
      const deletedDescriptors = deleted.filter(uri => this.isDescriptorUri(uri));
      if (changedDescriptors.length === 0 && deletedDescriptors.length === 0) {
         return;
      }
      // Descriptor removals below mutate the maps `computeProject` reads; drop the
      // memoized results now (adds also re-clear via `loadDescriptor`), so the
      // `getProject` calls in `collectAffectedDocuments` see the post-change state.
      this.invalidateMembershipCache();
      // Note: we intentionally do NOT await `ready` here. In the production
      // flow `discoverProjects` completes (resolving `ready`) inside
      // `HydraniumWorkspaceManager.performStartup` before `documentBuilder.build`
      // runs, so the registry is already populated by the time `onUpdate`
      // fires. Awaiting would deadlock test scenarios that exercise
      // `parseDocument` directly without going through workspace startup.

      const added: string[] = [];
      const updated: string[] = [];
      const removed: Array<{ id: string; snapshot: TProject }> = [];
      // Ids whose member documents must rebuild. Added and removed projects
      // always qualify; an updated project only when a member-observable field
      // changed (see requiresMemberRebuild) — a metadata-only change still
      // emits an `updated` event but drives no member rebuild.
      const rebuildIds: string[] = [];

      for (const uri of changedDescriptors) {
         const uriStr = uri.toString();
         const previousProjectId = this.projectByDescriptor.get(uriStr);
         const previousProject = previousProjectId ? this.projects.get(previousProjectId) : undefined;
         const newProject = await this.loadDescriptor(uri);
         if (newProject) {
            if (!previousProjectId) {
               added.push(newProject.id);
               rebuildIds.push(newProject.id);
            } else if (previousProjectId !== newProject.id) {
               // Descriptor file now describes a different project id — treat
               // as remove-old + add-new so dependents on the old id can react.
               this.projects.delete(previousProjectId);
               if (previousProject) {
                  removed.push({ id: previousProjectId, snapshot: previousProject });
                  this.logProjectChange('Remove', previousProjectId, uri);
               }
               added.push(newProject.id);
               rebuildIds.push(newProject.id);
            } else {
               updated.push(newProject.id);
               if (!previousProject || this.requiresMemberRebuild(previousProject, newProject)) {
                  rebuildIds.push(newProject.id);
               }
            }
         } else if (previousProjectId) {
            // Descriptor parsed before but now invalid — drop it.
            this.projects.delete(previousProjectId);
            this.projectByDescriptor.delete(uriStr);
            this.descriptorDirectories.delete(uriStr);
            if (previousProject) {
               removed.push({ id: previousProjectId, snapshot: previousProject });
               this.logProjectChange('Remove', previousProjectId, uri);
            }
         }
      }

      for (const uri of deletedDescriptors) {
         const uriStr = uri.toString();
         const projectId = this.projectByDescriptor.get(uriStr);
         if (projectId) {
            const snapshot = this.projects.get(projectId);
            this.projects.delete(projectId);
            this.projectByDescriptor.delete(uriStr);
            this.descriptorDirectories.delete(uriStr);
            if (snapshot) {
               removed.push({ id: projectId, snapshot });
               this.logProjectChange('Remove', projectId, uri);
            }
         }
      }

      if (added.length === 0 && updated.length === 0 && removed.length === 0) {
         return;
      }

      const removedIds = removed.map(entry => entry.id);
      const affectedProjectIds = new Set(this.getAffectedProjects([...rebuildIds, ...removedIds]));
      const excluded = new Set<string>();
      for (const uri of changedDescriptors) {
         excluded.add(uri.toString());
      }
      for (const uri of deletedDescriptors) {
         excluded.add(uri.toString());
      }
      const affectedDocuments = this.collectAffectedDocuments(affectedProjectIds, excluded);

      if (deferRelink) {
         // The build of the change already builds what it was given.
         const building = new Set(changed.map(uri => uri.toString()));
         const carried: URI[] = [];
         const deferred: URI[] = [];
         for (const uri of affectedDocuments) {
            if (building.has(uri.toString())) {
               continue;
            }
            const document = this.langiumDocuments.getDocument(uri);
            // Below its last phase, the build of the change builds it anyway.
            (document && document.state < this.lastPhaseOf(document) ? carried : deferred).push(uri);
         }
         this.queueMemberRelink(deferred);
         this.emit({ added, updated, removed, affectedDocuments: carried });
      } else {
         this.emit({ added, updated, removed, affectedDocuments });
      }
   }

   /**
    * Whether the build calling {@link onBuildUpdate} leaves the documents a
    * change affects to a follow-up build. Default: under
    * {@link deferMemberRelink}, unless an explicit `build` calls it. Called
    * before the first await of {@link onBuildUpdate}, where
    * `isInsideBuildUpdate` still answers for that call.
    */
   protected shouldDeferMemberRelink(): boolean {
      return this.deferMemberRelink && !this.documentBuilder.isInsideBuildUpdate();
   }

   /**
    * Iterate the document set once, collecting URIs whose owning project is in
    * the affected set. Override to add documents a change affects otherwise,
    * such as those reached through a project's type, calling `super` to keep
    * the members. What it returns is relinked as the members are, in the
    * build of the change or in the follow-up build.
    */
   protected collectAffectedDocuments(affectedProjectIds: ReadonlySet<string>, excludedUris: ReadonlySet<string>): URI[] {
      const result: URI[] = [];
      for (const document of this.langiumDocuments.all) {
         const uriStr = document.uri.toString();
         if (excludedUris.has(uriStr)) {
            continue;
         }
         const owning = this.getProject(document.uri);
         if (owning && affectedProjectIds.has(owning.id)) {
            result.push(document.uri);
         }
      }
      return result;
   }

   // ============================================================
   // Deferred member relink
   // ============================================================

   /** One that throws is logged and skipped. */
   onMemberRelinkStarted(listener: MemberRelinkStartedListener): Disposable {
      this.memberRelinkStartedListeners.add(listener);
      return Disposable.create(() => this.memberRelinkStartedListeners.delete(listener));
   }

   /** One that throws is logged and skipped. */
   onMemberRelinkFinished(listener: MemberRelinkFinishedListener): Disposable {
      this.memberRelinkFinishedListeners.add(listener);
      return Disposable.create(() => this.memberRelinkFinishedListeners.delete(listener));
   }

   memberRelinkSettled(): Promise<void> {
      // The relink's write may be queued behind the caller's read.
      return releaseReadHolds(this.workspaceLock, async () => {
         while (this.memberRelinks.size > 0) {
            await Promise.all(this.memberRelinks);
         }
      });
   }

   /**
    * Add `documents` to {@link pendingMemberRelink}, to be reset before they
    * are built when `reset` holds, and start a {@link runMemberRelink} unless
    * one is already waiting to take them.
    */
   protected queueMemberRelink(documents: readonly URI[], reset = true): void {
      if (!this.memberPhaseListenersRegistered && documents.length > 0) {
         this.registerMemberPhaseListeners();
      }
      for (const uri of documents) {
         const key = uri.toString();
         this.pendingMemberRelink.set(key, uri);
         this.unrelinkedMembers.add(key);
         if (reset) {
            this.pendingMemberResets.add(key);
            this.linkedMembers.delete(key);
         }
      }
      if (this.memberRelinkQueued || this.pendingMemberRelink.size === 0) {
         return;
      }
      this.memberRelinkQueued = true;
      // Later queues feed it, so it must not run in, and release, a read it was queued from.
      const settled = runOutsideReadLockScope(() => this.runMemberRelink());
      this.memberRelinks.add(settled);
      void settled.finally(() => this.memberRelinks.delete(settled));
   }

   /**
    * Take {@link pendingMemberRelink} in a lock read and build it in a write
    * queued from there. The read runs once no write runs or is queued, so the
    * write does not cancel the build of the change, as one queued from inside
    * that build would. It still cancels a write another read of the same batch
    * queued before it. If that write is a build that has started, the
    * follow-up builds the documents it reset, since an update builds every
    * document below `Validated`. The read does not await its write, which
    * waits for the read to end.
    *
    * The follow-up waits for any build already running outside the lock to
    * end, so it does not start alongside one. A build started outside the lock
    * after that can still overlap it, as any two such builds can. The wait
    * runs after the read rather than in it, since a wait under the lock would
    * hold back every write, and a write queued outside a read could cancel one
    * already queued, so the read runs again.
    */
   protected async runMemberRelink(): Promise<void> {
      const next = await this.workspaceLock.read(() => {
         const running = this.documentBuilder.activeBuild;
         if (running) {
            return { running };
         }
         this.memberRelinkQueued = false;
         const uris = [...this.pendingMemberRelink.values()];
         const resets = new Set(this.pendingMemberResets);
         this.pendingMemberRelink.clear();
         this.pendingMemberResets.clear();
         // A write cancels the one queued before it, so none is queued for nothing.
         if (uris.length === 0) {
            return { relink: Promise.resolve() };
         }
         return { relink: this.workspaceLock.write(token => this.relinkMembers(uris, resets, token)) };
      });
      if (next.running) {
         await next.running;
         return this.runMemberRelink();
      }
      return next.relink;
   }

   /**
    * The write action of a deferred relink: take the documents still loaded
    * that no build has relinked since they were queued, and build them. Those
    * in `resets`, and those already at their last phase, are reset first by a
    * {@link ProjectChangeEvent} that carries only them, so the workspace
    * manager's `onProjectsChanged` resets them as it does without the option.
    * An `update` with no URIs builds what is left below `Validated`, and
    * Langium relinks every document with a linking error too, without
    * reporting the members to `onUpdate` listeners as changed.
    *
    * A write cancelled before it starts is queued again as it was, unannounced.
    * A cancelled build is queued again, without resets, with only the members
    * it did not relink. One a cancel left at its last phase before its
    * listeners all ran is reset then, since Langium does not run them again.
    * If none is left, nothing is built or announced. A build that ends,
    * completed or failed, stops tracking the members it took, except those a
    * change queued again meanwhile. A failed build is not queued again, since
    * it would fail again. Never throws, so {@link memberRelinkSettled} never
    * rejects.
    */
   protected async relinkMembers(uris: readonly URI[], resets: ReadonlySet<string>, token: CancellationToken): Promise<void> {
      const loaded: URI[] = [];
      for (const uri of uris) {
         const key = uri.toString();
         if (!this.unrelinkedMembers.has(key)) {
            continue;
         }
         if (this.langiumDocuments.getDocument(uri)) {
            loaded.push(uri);
         } else {
            this.forgetMember(key);
         }
      }
      if (loaded.length === 0) {
         return;
      }
      const forgetTaken = (): void =>
         loaded.filter(uri => !this.pendingMemberRelink.has(uri.toString())).forEach(uri => this.forgetMember(uri.toString()));
      if (token.isCancellationRequested) {
         this.queueMemberRelink(loaded.filter(uri => resets.has(uri.toString())));
         this.queueMemberRelink(
            loaded.filter(uri => !resets.has(uri.toString())),
            false
         );
         return;
      }
      this.notifyMemberRelink(this.memberRelinkStartedListeners, loaded);
      let completed = false;
      try {
         const reset = loaded.filter(uri => {
            const document = this.langiumDocuments.getDocument(uri);
            return document !== undefined && (resets.has(uri.toString()) || document.state >= this.lastPhaseOf(document));
         });
         if (reset.length > 0) {
            reset.forEach(uri => this.linkedMembers.delete(uri.toString()));
            this.emit({ added: [], updated: [], removed: [], affectedDocuments: reset });
         }
         this.documentBuilder.markNextReason(HYDRANIUM_BUILD_REASONS.memberRelink);
         await this.documentBuilder.update([], [], token);
         // A cancel a last-phase listener swallowed can leave `update` resolved.
         if (token.isCancellationRequested) {
            throw OperationCancelled;
         }
         completed = true;
         // Built all the same if no listener saw it linked or delivered.
         forgetTaken();
      } catch (error: unknown) {
         if (isOperationCancelled(error)) {
            // A cancel can skip the Linked listeners, and Langium does not
            // notify that phase again.
            for (const uri of loaded) {
               const document = this.langiumDocuments.getDocument(uri);
               if (document && document.state >= DocumentState.Linked) {
                  this.onMemberLinked(uri);
               }
            }
            this.queueMemberRelink(
               loaded.filter(uri => this.unrelinkedMembers.has(uri.toString())),
               false
            );
         } else {
            forgetTaken();
            this.tracer.error(`Relinking ${this.conceptName()} members failed: ${describeErrorWithStack(error)}`);
         }
      } finally {
         this.notifyMemberRelink<MemberRelinkFinishedEvent>(this.memberRelinkFinishedListeners, { completed });
      }
   }

   /** Record that a build linked `uri`, if it is a member not relinked yet. */
   protected onMemberLinked(uri: URI): void {
      const key = uri.toString();
      if (this.unrelinkedMembers.has(key)) {
         this.linkedMembers.add(key);
      }
   }

   /** The last phase the build that carries `document` takes it to. */
   protected lastPhaseOf(document: LangiumDocument): DocumentState {
      return this.documentBuilder.shouldValidateDocument(document) ? DocumentState.Validated : DocumentState.IndexedReferences;
   }

   /**
    * A member linked since it was queued and now delivered at its last phase
    * is relinked, whichever build did it, so no follow-up builds it again.
    */
   protected onMemberDelivered(uri: URI): void {
      const key = uri.toString();
      if (this.linkedMembers.has(key)) {
         this.forgetMember(key);
         this.pendingMemberRelink.delete(key);
         this.pendingMemberResets.delete(key);
      }
   }

   /** Drop `key` from the relink bookkeeping. */
   protected forgetMember(key: string): void {
      this.unrelinkedMembers.delete(key);
      this.linkedMembers.delete(key);
   }

   /** Call each of `listeners` with `value`, each in isolation. */
   protected notifyMemberRelink<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
      for (const listener of [...listeners]) {
         try {
            listener(value);
         } catch (error: unknown) {
            this.tracer.error(`A member relink listener failed: ${describeErrorWithStack(error)}`);
         }
      }
   }

   // ============================================================
   // Queries
   // ============================================================

   /**
    * The project owning the given URI, memoized per URI (see {@link membershipCache}).
    * The membership computation lives in {@link computeProject} — override THAT, not
    * this, so a subclass's custom model inherits the memoization + invalidation.
    */
   getProject(uri: URI | string): TProject | undefined {
      const target = UriUtils.toUri(uri);
      const targetStr = target.toString();
      if (this.membershipCache.has(targetStr)) {
         return this.membershipCache.get(targetStr);
      }
      const result = this.computeProject(target);
      this.membershipCache.set(targetStr, result);
      return result;
   }

   /**
    * Compute the project owning {@link target} — default: the project whose descriptor
    * directory is the closest ancestor. Subclasses override for a different membership
    * model; the result is memoized by {@link getProject}.
    *
    * The lookup is O(N) in the number of registered projects per call, but memoization
    * collapses the repeated per-description / per-node calls to one per URI per rebuild.
    * Subclasses that additionally need O(1) per unique URI can maintain a reverse index.
    */
   protected computeProject(target: URI): TProject | undefined {
      // Direct hit on a descriptor URI is the owning project itself.
      const directProjectId = this.projectByDescriptor.get(target.toString());
      if (directProjectId) {
         return this.projects.get(directProjectId);
      }

      // Otherwise, find the closest-ancestor descriptor directory.
      let bestDescriptorUri: string | undefined;
      let bestLength = -1;
      for (const [descriptorUri, directory] of this.descriptorDirectories) {
         if (UriUtils.isAncestorOrEqual(directory, target) && directory.fsPath.length > bestLength) {
            bestDescriptorUri = descriptorUri;
            bestLength = directory.fsPath.length;
         }
      }
      if (!bestDescriptorUri) {
         return undefined;
      }
      const projectId = this.projectByDescriptor.get(bestDescriptorUri);
      return projectId ? this.projects.get(projectId) : undefined;
   }

   /** Drop all memoized membership results. Called wherever the descriptor maps mutate. */
   protected invalidateMembershipCache(): void {
      this.membershipCache.clear();
   }

   getProjectForNode(node: AstNode): TProject | undefined {
      const uri = AstUtils.findRootNode(node).$document?.uri;
      return uri ? this.getProject(uri) : undefined;
   }

   getProjectById(id: string): TProject | undefined {
      return this.projects.get(id);
   }

   getProjects(): readonly TProject[] {
      return Array.from(this.projects.values());
   }

   getProjectUris(projectId: string): readonly URI[] {
      if (!this.projects.has(projectId)) {
         return [];
      }
      const result: URI[] = [];
      for (const document of this.langiumDocuments.all) {
         if (this.getProject(document.uri)?.id === projectId) {
            result.push(document.uri);
         }
      }
      return result;
   }

   // ============================================================
   // Event emission
   // ============================================================

   protected emit(event: ProjectChangeEvent<TProject>): void {
      // Copy the listener list so a listener registering or disposing
      // during iteration doesn't mutate the array we're walking.
      const snapshot = this.listeners.slice();
      for (const listener of snapshot) {
         try {
            listener(event);
         } catch (error) {
            this.tracer.error(`Project change listener failed: ${describeErrorWithStack(error)}`);
         }
      }
   }
}

/** Order-independent equality of two projects' dependency id sets. */
function sameDependencies(a: Project, b: Project): boolean {
   const previous = a.dependencies ?? [];
   const next = b.dependencies ?? [];
   if (previous.length !== next.length) {
      return false;
   }
   const nextSet = new Set(next);
   return previous.every(dep => nextSet.has(dep));
}
