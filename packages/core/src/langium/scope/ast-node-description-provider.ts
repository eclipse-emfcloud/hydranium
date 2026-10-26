/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   CstUtils,
   DefaultAstNodeDescriptionProvider,
   type DocumentSegment,
   type LangiumDocument,
   type URI
} from '@hydranium/langium';
import type { LogNameOptions } from '../diagnostics/logger.js';
import type { HydraniumLanguageServices } from '../language-module.js';
import { type DescriptionTier, type TieredAstNodeDescription } from './scoped-ast-node-description.js';

/**
 * Framework `AstNodeDescriptionProvider` extension. Adds four typed
 * factory methods aligned with the {@link TieredAstNodeDescription} four-
 * tier visibility model:
 *
 * - {@link createLocal}     — `tier: 'local'`; document-only (not in global index).
 * - {@link createProject}   — `tier: 'project'`; owning project only (equality filter).
 * - {@link createPublic}    — `tier: 'public'`; dependent projects only (own-project filter + closure).
 * - {@link createUniversal} — `tier: 'universal'`; visible everywhere unconditionally.
 *
 * # Synthetic AST contributions
 *
 * Every factory requires a `LangiumDocument`. In-memory AST content with no
 * file behind it reaches them by wrapping its root node in a virtual
 * document through Langium's `LangiumDocumentFactory.fromModel`; see
 * `virtualUri` for the URI-construction helper.
 */
export class HydraniumAstNodeDescriptionProvider extends DefaultAstNodeDescriptionProvider {
   protected readonly tracer: Tracer;
   protected readonly services: HydraniumLanguageServices;

   constructor(services: HydraniumLanguageServices, options: LogNameOptions = {}) {
      super(services);
      this.services = services;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'AstNodeDescriptionProvider').trace('instantiated');
   }

   /**
    * Overrides the Langium base to stamp `tier: 'local'` on every plain
    * description so no un-tiered descriptions escape into the framework
    * filter pipeline. Callers that need a different tier must use
    * {@link createProject}, {@link createPublic}, or {@link createUniversal}.
    *
    * Langium's own `createDescription` is not called: every factory builds
    * through {@link createTiered}.
    */
   override createDescription(node: AstNode, name: string | undefined, document?: LangiumDocument): TieredAstNodeDescription {
      return this.createTiered(node, name, document, 'local');
   }

   /**
    * Build a {@link TieredAstNodeDescription} for a symbol visible only
    * inside its document. Goes into the per-document local-symbols map
    * via `ScopeComputation.collectLocalSymbols`; not exported into
    * the workspace index.
    *
    * Local descriptions never carry `projectId` — the project filter
    * never sees them, so a project tag would be unused.
    */
   createLocal(options: { readonly node: AstNode; readonly name: string; readonly document: LangiumDocument }): TieredAstNodeDescription {
      return this.createTiered(options.node, options.name, options.document, 'local');
   }

   /**
    * Build a {@link TieredAstNodeDescription} for a symbol visible inside
    * its owning project only — the filter compares `projectId` against the
    * source's project for equality, not for membership of the dependency
    * closure. Cross-project access goes through the `'public'`-tier sibling
    * that {@link createPublic} builds.
    *
    * `projectId` is required — the framework filter reads it directly to
    * decide visibility instead of doing a URI → project lookup per
    * description on the hot path. Pass the id of the project that owns
    * `document`; the typical exporter sources it from
    * `ProjectManager.getProject(document.uri)?.id` once per document.
    */
   createProject(options: {
      readonly node: AstNode;
      readonly name: string;
      readonly document: LangiumDocument;
      readonly projectId: string;
   }): TieredAstNodeDescription {
      return this.createTiered(options.node, options.name, options.document, 'project', options.projectId);
   }

   /**
    * Build a {@link TieredAstNodeDescription} at `tier: 'public'` — the
    * public-tier sibling of a multi-tier emission. Visible to other
    * projects in the source's dependency closure; suppressed inside its
    * owning project (where the `'project'`-tier sibling under a shorter
    * name is the canonical entry).
    *
    * `projectId` is REQUIRED. It identifies the owning project; the
    * framework filter reads it directly to enforce the own-project
    * canonical filter + closure membership without a URI-to-project
    * lookup on the hot path.
    *
    * Use when exporting a node under two names — a short project-internal
    * one and a workspace-qualified one.
    */
   createPublic(options: {
      readonly node: AstNode;
      readonly name: string;
      readonly document: LangiumDocument;
      readonly projectId: string;
   }): TieredAstNodeDescription {
      return this.createTiered(options.node, options.name, options.document, 'public', options.projectId);
   }

   /**
    * Build a {@link TieredAstNodeDescription} at `tier: 'universal'` —
    * visible everywhere unconditionally. Used for synthetic / library /
    * stdlib content with no project ownership.
    *
    * `projectId` is forbidden by the type signature; universal
    * descriptions have no owning project. If the node DOES have an
    * owning project and should participate in multi-tier emission, use
    * {@link createPublic} instead.
    */
   createUniversal(options: {
      readonly node: AstNode;
      readonly name: string;
      readonly document: LangiumDocument;
   }): TieredAstNodeDescription {
      return this.createTiered(options.node, options.name, options.document, 'universal');
   }

   /**
    * Resolve the fields of the description every factory returns and build it
    * through {@link newDescription}. Mirrors Langium's `createDescription`:
    * the name defaults to the name provider's, and a node without one throws.
    */
   protected createTiered(
      node: AstNode,
      name: string | undefined,
      document: LangiumDocument | undefined,
      tier: DescriptionTier,
      projectId?: string
   ): TieredAstNodeDescription {
      const path = this.astNodeLocator.getAstNodePath(node);
      const resolvedName = name ?? this.nameProvider.getName(node);
      if (!resolvedName) {
         throw new Error(`Node at path ${path} has no name.`);
      }
      const documentUri = (document ?? AstUtils.getDocument(node)).uri;
      return this.newDescription(node, resolvedName, documentUri, path, tier, projectId);
   }

   /** Construct the description from resolved fields; override to build a subclass of {@link DefaultTieredAstNodeDescription}. */
   protected newDescription(
      node: AstNode,
      name: string,
      documentUri: URI,
      path: string,
      tier: DescriptionTier,
      projectId: string | undefined
   ): TieredAstNodeDescription {
      return new DefaultTieredAstNodeDescription(this, node, name, documentUri, path, tier, projectId);
   }

   /**
    * The segment of `node`'s name, or of the whole node when the name
    * provider finds no name node, restoring a shed CST first: a name provider
    * need not restore it, and an absent segment is not computed again.
    */
   nameSegmentOf(node: AstNode): DocumentSegment | undefined {
      this.services.shared.workspace.CstResidencyService.rehydrateNode(node);
      return CstUtils.toDocumentSegment(this.nameProvider.getNameNode(node) ?? node.$cstNode);
   }

   /** The segment of the whole node, restoring a shed CST first. */
   selectionSegmentOf(node: AstNode): DocumentSegment | undefined {
      this.services.shared.workspace.CstResidencyService.rehydrateNode(node);
      return CstUtils.toDocumentSegment(node.$cstNode);
   }
}

/**
 * The description {@link HydraniumAstNodeDescriptionProvider} builds. Every
 * field is set in the constructor, so all descriptions share one V8 hidden
 * class; Langium's object literal with a `nameSegment` accessor is kept in
 * dictionary mode and carries two closures, several times the bytes.
 *
 * `nameSegment` and `selectionSegment` are prototype getters, not own
 * properties: a spread, `Object.keys`, a JSON round trip or `structuredClone`
 * of a description drops them. Each is computed on its first read, from the
 * node the description was built for, restoring a shed CST first; an eager
 * `selectionSegment` would keep a segment per description that nothing reads.
 */
export class DefaultTieredAstNodeDescription implements TieredAstNodeDescription {
   readonly type: string;
   // `null` records a segment computed while the node had no CST. It is
   // recomputed only once the node has one again: retrying without one would
   // attempt a restore, a re-parse, on every read.
   protected nameSegmentCache: DocumentSegment | null | undefined;
   protected selectionSegmentCache: DocumentSegment | null | undefined;

   constructor(
      protected readonly provider: HydraniumAstNodeDescriptionProvider,
      readonly node: AstNode,
      readonly name: string,
      readonly documentUri: URI,
      readonly path: string,
      readonly tier: DescriptionTier,
      readonly projectId: string | undefined
   ) {
      this.type = node.$type;
   }

   get nameSegment(): DocumentSegment | undefined {
      if (this.nameSegmentCache === undefined || (this.nameSegmentCache === null && this.node.$cstNode !== undefined)) {
         this.nameSegmentCache = this.provider.nameSegmentOf(this.node) ?? null;
      }
      return this.nameSegmentCache ?? undefined;
   }

   get selectionSegment(): DocumentSegment | undefined {
      if (this.selectionSegmentCache === undefined || (this.selectionSegmentCache === null && this.node.$cstNode !== undefined)) {
         this.selectionSegmentCache = this.provider.selectionSegmentOf(this.node) ?? null;
      }
      return this.selectionSegmentCache ?? undefined;
   }
}
