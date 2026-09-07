/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode, type AstNodeDescription, DefaultAstNodeDescriptionProvider, type LangiumDocument } from '@hydranium/langium';
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

   constructor(services: HydraniumLanguageServices, options: LogNameOptions = {}) {
      super(services);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'AstNodeDescriptionProvider').trace('instantiated');
   }

   /**
    * Overrides the Langium base to stamp `tier: 'local'` on every plain
    * description so no un-tiered descriptions escape into the framework
    * filter pipeline. Callers that need a different tier must use
    * {@link createProject}, {@link createPublic}, or {@link createUniversal}.
    *
    * The named factory methods bypass this override by calling
    * `super.createDescription` to get a plain base before stamping the
    * correct tier — so there is no create-then-overwrite cost.
    */
   override createDescription(node: AstNode, name: string, document: LangiumDocument): TieredAstNodeDescription {
      return this.toTiered(super.createDescription(node, name, document), 'local');
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
      return this.toTiered(super.createDescription(options.node, options.name, options.document), 'local');
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
      return this.toTiered(super.createDescription(options.node, options.name, options.document), 'project', options.projectId);
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
      return this.toTiered(super.createDescription(options.node, options.name, options.document), 'public', options.projectId);
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
      return this.toTiered(super.createDescription(options.node, options.name, options.document), 'universal');
   }

   /**
    * Attach `tier` + `projectId` fields to a plain {@link AstNodeDescription}
    * in place, narrowing the static type to {@link TieredAstNodeDescription}.
    * Mutates `base` rather than copying — the input is treated as
    * just-constructed and not aliased elsewhere.
    */
   protected toTiered(base: AstNodeDescription, tier: DescriptionTier, projectId?: string): TieredAstNodeDescription {
      return Object.assign(base, { tier, projectId }) as TieredAstNodeDescription;
   }
}
