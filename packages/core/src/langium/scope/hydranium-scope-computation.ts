/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type AstNode,
   type AstNodeDescription,
   DefaultScopeComputation,
   type LangiumDocument,
   type LocalSymbols,
   type MultiMap,
   UriUtils
} from '@hydranium/langium';
import { Logger, type ProfileSession, type Tracer } from '@hydranium/protocol';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { LogNameOptions } from '../diagnostics/logger.js';
import type { HydraniumLanguageServices } from '../language-module.js';
import type { NameProvider } from '../naming/name-provider.js';
import { type HydraniumAstNodeDescriptionProvider } from './ast-node-description-provider.js';

/**
 * Default scope computation for `@hydranium/core` consumers. Two
 * framework behaviours layered on top of Langium's
 * {@link DefaultScopeComputation}:
 *
 * - **Local symbols use bare own-names.** Langium's default keys local
 *   symbols by `nameProvider.getName(node)` — but in this framework
 *   `NameProvider.getName` defaults to the workspace-unique
 *   `getProjectQualifiedName`. Routing the local-symbols pass through
 *   `getName` would put qualified names in the per-document symbol map
 *   and break within-document bare-name references.
 *   {@link addLocalSymbolByOwnName} bypasses the default and calls
 *   {@link NameProvider.getOwnName}
 *   directly so local symbols stay keyed by bare names regardless of
 *   what `getName` returns.
 *
 * - **Exported symbols emit document-qualified plus conditional
 *   project-qualified dual.** {@link addExportedSymbol} produces a
 *   primary `TieredAstNodeDescription` keyed by
 *   {@link NameProvider.getDocumentQualifiedName} and, when the owning
 *   project qualifies its names (its `referenceName` is non-empty),
 *   ALSO emits a second `tier: 'public'` description keyed by
 *   {@link NameProvider.getProjectQualifiedName}. Cross-document
 *   references within a project resolve against the document-qualified
 *   form; cross-project references against the project-qualified form.
 *   When the project does not qualify its names
 *   (`UNQUALIFIED_PROJECT_REFERENCE`), the two forms are identical and
 *   the multi-tier emission collapses to a single description.
 *
 * Performance: piggybacks on the existing single AST walk Langium does
 * for local-symbol collection — the AST-extension dispatch and the
 * own-name read both happen in `addLocalSymbolByOwnName`, no extra traversal.
 * The exported-symbol pass reads both name tiers once per node, no
 * duplicated walks.
 */
export class HydraniumScopeComputation extends DefaultScopeComputation {
   /** The framework's name provider, which its language module binds to the slot. */
   declare protected readonly nameProvider: NameProvider;
   /** The framework's description provider, which its language module binds to the slot. */
   declare protected readonly descriptions: HydraniumAstNodeDescriptionProvider;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: LogNameOptions = {}
   ) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ScopeComputation').trace('instantiated');
   }

   /** The session {@link addLocalSymbol} records into while a `debug`-level walk runs. */
   protected localSymbolsProfile: ProfileSession | undefined;

   /**
    * Langium's local-symbol walk, with per-`$type` self-time profiling at
    * `debug`. The walk is Langium's at every level: a copy run only at `debug`
    * would drift from the one every other level runs. Overlapping builds share
    * the session and blur each other's report.
    */
   override async collectLocalSymbols(document: LangiumDocument, cancelToken?: CancellationToken): Promise<LocalSymbols> {
      if (!Logger.isLevelEnabled('debug')) {
         return super.collectLocalSymbols(document, cancelToken);
      }
      const profile = this.tracer.profile(`scope-local ${UriUtils.basename(document.uri)}`);
      this.localSymbolsProfile = profile;
      let symbols: LocalSymbols;
      try {
         symbols = await super.collectLocalSymbols(document, cancelToken);
      } finally {
         if (this.localSymbolsProfile === profile) {
            this.localSymbolsProfile = undefined;
         }
      }
      profile.report('debug');
      return symbols;
   }

   /**
    * Emit one or two `TieredAstNodeDescription`s for the named node
    * per the multi-tier emission rule:
    *
    * 1. Primary emit — name = {@link NameProvider.getDocumentQualifiedName}.
    *    `tier: 'project'` when the document has an owning project (the
    *    `projectId` field drives the equality-match filter rule);
    *    `tier: 'universal'` otherwise (loose document, no project).
    * 2. Conditional public-tier emit — `tier: 'public'` description with
    *    name = {@link NameProvider.getProjectQualifiedName}. Fires ONLY
    *    when the project qualifies its names (project-qualified ≠
    *    document-qualified) and the document has an owning project.
    *    The public description carries the same `projectId` so the
    *    filter hides it inside the owning project (the
    *    `'project'`-tier sibling under the shorter name is the
    *    canonical entry there) and shows it to dependent projects in
    *    the source's visibility closure.
    *
    * # Why this multi-tier shape
    *
    * Mainstream languages let users write the closest unambiguous name:
    * bare within the same container (handled by local symbols),
    * document-qualified within the same project (the primary emit),
    * project-qualified across projects (the public-tier emit). The
    * framework does NOT require adopters to multi-tier emit explicitly;
    * the same node goes into the global index under TWO names, and the
    * visibility filter picks the right one per query.
    *
    * # When the multi-tier emission collapses
    *
    * If the project's `referenceName` equals
    * `UNQUALIFIED_PROJECT_REFERENCE` (empty sentinel), then
    * `getProjectQualifiedName` collapses to `getDocumentQualifiedName`
    * — same string. The conditional public-tier branch's
    * `projectName !== documentName` guard skips the redundant emit.
    *
    * # Override surface
    *
    * Adopters with a non-default naming scheme override
    * `NameProvider.getDocumentQualifiedName` /
    * `getProjectQualifiedName` / `getProjectReferenceName` rather than
    * this method. The multi-tier emission machinery falls out from the
    * per-emit string comparison; adopters don't need to reimplement it.
    */
   protected override addExportedSymbol(node: AstNode, exports: AstNodeDescription[], document: LangiumDocument): void {
      this.exportProject(node, exports, document);
      this.exportPublic(node, exports, document);
   }

   /**
    * Primary emit hook — `tier: 'project'` description keyed by
    * `NameProvider.getDocumentQualifiedName`. Adopters override this to
    * customise the primary descriptor's name source or to skip it entirely.
    *
    * When the document has no owning project, emits at `tier: 'universal'`
    * instead, so a loose document with no project context stays
    * workspace-visible rather than being filtered out everywhere.
    */
   protected exportProject(node: AstNode, exports: AstNodeDescription[], document: LangiumDocument): void {
      const documentName = this.nameProvider.getDocumentQualifiedName(node);
      if (!documentName) {
         return;
      }
      const projectId = this.getProjectIdForDocument(document);
      exports.push(
         projectId !== undefined
            ? this.descriptions.createProject({ node, name: documentName, document, projectId })
            : this.descriptions.createUniversal({ node, name: documentName, document })
      );
   }

   /**
    * Conditional public-tier emit hook — `tier: 'public'` description keyed
    * by `NameProvider.getProjectQualifiedName`. Fires only when the
    * project-qualified name differs from the document-qualified name
    * (i.e. the owning project qualifies its names) AND the document
    * has an owning project.
    *
    * Adopters override this to emit the public tier under different
    * conditions — for instance to emit it unconditionally for library-style
    * content that must be reachable across project boundaries under its
    * document-qualified name.
    */
   protected exportPublic(node: AstNode, exports: AstNodeDescription[], document: LangiumDocument): void {
      const projectId = this.getProjectIdForDocument(document);
      if (projectId === undefined) {
         return;
      }
      const documentName = this.nameProvider.getDocumentQualifiedName(node);
      const projectName = this.nameProvider.getProjectQualifiedName(node);
      if (projectName && projectName !== documentName) {
         exports.push(this.descriptions.createPublic({ node, name: projectName, document, projectId }));
      }
   }

   /**
    * Read the owning project id for `document` from the shared
    * `ProjectManager`. Returns `undefined` when the document is outside
    * any registered project — typical for loose files in single-folder
    * workspaces or adopters using a `NoopProjectManager`-style binding.
    *
    * Override for adopters whose project ownership comes from a
    * different source than `ProjectManager.getProject(document.uri)`
    * (e.g. a per-document descriptor service).
    */
   protected getProjectIdForDocument(document: LangiumDocument): string | undefined {
      return this.services.shared.workspace.ProjectManager.getProject(document.uri)?.id;
   }

   /** {@link addLocalSymbolByOwnName}, timed per `$type` while {@link localSymbolsProfile} is set. */
   protected override addLocalSymbol(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
      const profile = this.localSymbolsProfile;
      if (profile) {
         profile.scope(node.$type, () => this.addLocalSymbolByOwnName(node, document, symbols));
      } else {
         this.addLocalSymbolByOwnName(node, document, symbols);
      }
   }

   /**
    * Bypasses Langium's `super.addLocalSymbol` (which would key the
    * local-symbols map by `nameProvider.getName(node)`, qualified by
    * default in this framework). Reads {@link NameProvider.getOwnName}
    * directly so the local-symbols map stays keyed by bare names,
    * matching the `getOwnName` qualification level's use case
    * ("references within the same container — resolved via Langium's
    * local symbols").
    *
    * AST-extension dispatch is independent of this method — the framework's
    * `AstExtensionService` attaches its own `onDocumentPhase(ComputedScopes)`
    * listener when any registration declares a `ComputedScopes` callback, so
    * extension `compute` callbacks fire after this `addLocalSymbol` pass
    * completes for the whole document.
    */
   protected addLocalSymbolByOwnName(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
      const container = node.$container;
      if (!container) {
         return;
      }
      const name = this.nameProvider.getOwnName(node);
      if (name) {
         symbols.add(container, this.descriptions.createLocal({ node, name, document }));
      }
   }
}
