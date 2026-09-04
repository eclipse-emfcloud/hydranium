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
   AstUtils,
   DefaultScopeComputation,
   interruptAndCheck,
   type LangiumDocument,
   type LocalSymbols,
   MultiMap,
   UriUtils
} from '@hydranium/langium';
import { Logger, type Tracer } from '@hydranium/protocol';
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
 *   and break within-document bare-name references. {@link addLocalSymbol}
 *   bypasses the default and calls {@link NameProvider.getOwnName}
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
 * own-name read both happen in `addLocalSymbol`, no extra traversal.
 * The exported-symbol pass reads both name tiers once per node, no
 * duplicated walks.
 */
export class HydraniumScopeComputation extends DefaultScopeComputation {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: LogNameOptions = {}
   ) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ScopeComputation').trace('instantiated');
   }

   /**
    * Local-symbol collection with optional per-`$type` self-time profiling.
    *
    * Langium's default walks the full AST and calls {@link addLocalSymbol} per
    * node. At the default `info` level this delegates straight to `super` (zero
    * cost). At `debug` it reproduces the same walk under a `ProfileSession`
    * so each `$type`'s contribution to the heaviest scope-computation pass is
    * aggregated and reported line-based — the walk is gated rather than the
    * per-node `scope`, since `ProfileSession.scope` is not itself level-gated.
    *
    * The instance carries no profiling state: the session is local to the call,
    * which is safe because Langium's document builder runs `collectLocalSymbols`
    * strictly one document at a time (`runCancelable`'s sequential `for…await`).
    */
   override async collectLocalSymbols(document: LangiumDocument, cancelToken?: CancellationToken): Promise<LocalSymbols> {
      if (!Logger.isLevelEnabled('debug')) {
         return super.collectLocalSymbols(document, cancelToken);
      }
      // Faithfully reproduces Langium's local-symbol walk (root's full-AST stream
      // → addLocalSymbol per node) under a session. The MultiMap conforms to
      // LocalSymbols. interruptAndCheck only when a token is supplied (the base
      // defaults to CancellationToken.None, a no-op token).
      const rootNode = document.parseResult.value;
      const symbols = new MultiMap<AstNode, AstNodeDescription>();
      const session = this.tracer.profile(`scope-local ${UriUtils.basename(document.uri)}`);
      for (const node of AstUtils.streamAllContents(rootNode)) {
         if (cancelToken) {
            await interruptAndCheck(cancelToken);
         }
         session.scope(node.$type, () => this.addLocalSymbol(node, document, symbols));
      }
      session.report('debug');
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
      const nameProvider = this.nameProvider as NameProvider;
      const documentName = nameProvider.getDocumentQualifiedName(node);
      if (!documentName) {
         return;
      }
      const projectId = this.getProjectIdForDocument(document);
      const descriptions = this.descriptions as HydraniumAstNodeDescriptionProvider;
      exports.push(
         projectId !== undefined
            ? descriptions.createProject({ node, name: documentName, document, projectId })
            : descriptions.createUniversal({ node, name: documentName, document })
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
      const nameProvider = this.nameProvider as NameProvider;
      const projectId = this.getProjectIdForDocument(document);
      if (projectId === undefined) {
         return;
      }
      const documentName = nameProvider.getDocumentQualifiedName(node);
      const projectName = nameProvider.getProjectQualifiedName(node);
      if (projectName && projectName !== documentName) {
         const descriptions = this.descriptions as HydraniumAstNodeDescriptionProvider;
         exports.push(descriptions.createPublic({ node, name: projectName, document, projectId }));
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
   protected override addLocalSymbol(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
      const container = node.$container;
      if (!container) {
         return;
      }
      const name = (this.nameProvider as NameProvider).getOwnName(node);
      if (name) {
         symbols.add(container, (this.descriptions as HydraniumAstNodeDescriptionProvider).createLocal({ node, name, document }));
      }
   }
}
