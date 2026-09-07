/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, AstUtils, type LangiumDocument, MapScope, type Scope, StreamScope, stream } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { type Tracer } from '@hydranium/protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { Registry, type RegistryItem } from '../../util/registry.js';
import { type HydraniumAstNodeDescriptionProvider } from './ast-node-description-provider.js';
import { type ScopeExtensionRegistry } from './scope-extension-contribution.js';
import { type TieredAstNodeDescription } from './scoped-ast-node-description.js';

/**
 * Acceptor passed to {@link ScopeExtension.addDescriptions}. Mirrors the
 * `ValidationAcceptor` pattern: a single parameter that hides both the
 * description factory and the result accumulator.
 *
 * Scope extensions are **query-time, per-context contributors** rebuilt on
 * every `getScope` call from the live reference context. Only two visibility
 * tiers are coherent for such contributors:
 * - `local(...)` — document-only symbol; layered above the project chain
 *   but below document-local. Most extension-scope descriptions.
 * - `universal(...)` — visible everywhere unconditionally; layered at the
 *   bottom of the chain (synthetic / stdlib content).
 *
 * **Why no `project` / `public` tiers**: `public` ("visible from dependent
 * projects") is undeliverable from a per-context contributor — a
 * contribution made while resolving a reference in document D is never
 * indexed, so a dependent project's query never sees it. Genuine
 * cross-project synthetic symbols go through the AST-extension / export
 * path (which IS indexed + tiered). `project` collapses into `local` —
 * since the extension is already scoped to this one query, "project
 * visibility" adds no real visibility over `local`. Use `createOwnProjectScope`
 * / `createDependencyScope` hooks on `HydraniumScopeProvider` for genuine
 * tier-weaving needs.
 */
export interface ScopeDescriptionAcceptor {
   local(options: { node: AstNode; name: string; document: LangiumDocument }): void;
   universal(options: { node: AstNode; name: string; document: LangiumDocument }): void;
   /**
    * Push a pre-built {@link TieredAstNodeDescription} directly — use when
    * descriptions are constructed ahead of time, to avoid per-query
    * allocation. The pushed description's `tier` must be `'local'` or
    * `'universal'`; a description of any other tier is silently dropped,
    * because the per-tier query methods only return descriptions matching
    * the tier they were asked for.
    */
   push(description: TieredAstNodeDescription): void;
}

/** Build a {@link ScopeDescriptionAcceptor} that synthesises typed descriptions via `descriptions` and accumulates them into `into`. */
function createScopeDescriptionAcceptor(
   into: TieredAstNodeDescription[],
   descriptions: HydraniumAstNodeDescriptionProvider
): ScopeDescriptionAcceptor {
   return {
      local: options => into.push(descriptions.createLocal(options)),
      universal: options => into.push(descriptions.createUniversal(options)),
      push: description => into.push(description)
   };
}

/**
 * A registration that contributes additional descriptions to the scope
 * computed by `getScope` for specific reference types. Contributed descriptions
 * layer at their declared tier (local above the project chain but below
 * document-local; universal at the bottom).
 */
export interface ScopeExtension extends RegistryItem {
   /** Reference types this extension applies to, as `$type` strings. */
   readonly referenceTypes: string[];
   /**
    * Contribute scope descriptions for the given context via `accept`.
    * If the extension does not apply, call nothing.
    *
    * Sync-only by Langium contract: invoked from `ScopeProvider.getScope`,
    * which Langium defines as synchronous. Adopters needing async work must
    * build the data up-front and hand a sync acceptor here.
    */
   addDescriptions(context: AstNode, referenceType: string, document: LangiumDocument, accept: ScopeDescriptionAcceptor): void;
}

/**
 * Public contract for the per-language scope-extension service. Extends
 * the {@link ScopeExtensionRegistry} (the imperative `register` surface
 * contributions use) with the per-tier query methods called cross-class
 * from `HydraniumScopeProvider`'s `layerLocalExtension` /
 * `layerUniversalExtension` helpers, which layer scope-extension
 * contributions around the cached project chain.
 *
 * Adopter overrides go through {@link DefaultScopeExtensionService}; the
 * interface keeps the public API stable while internals
 * (`collectExtensionDescriptions` walk) stay `protected` on the default
 * class.
 */
export interface ScopeExtensionService extends ScopeExtensionRegistry {
   /**
    * Layer this language's `local`-tier scope-extension descriptions on
    * top of `outerScope` for the given reference type. Returns
    * `outerScope` unchanged when no extension contributes a `local`-tier
    * description for the type (zero-cost common path).
    */
   getLocalExtensionScope(referenceType: string, context: AstNode, outerScope: Scope): Scope;
   /**
    * Layer this language's `universal`-tier scope-extension descriptions
    * BELOW `outerScope` for the given reference type. Returns `outerScope`
    * unchanged when no extension contributes a `universal`-tier
    * description for the type.
    */
   getUniversalExtensionScope(referenceType: string, context: AstNode, outerScope: Scope): Scope;
}

export type ScopeExtensionServiceOptions = LogNameOptions;

/**
 * Default {@link ScopeExtensionService} implementation. Per-language
 * registry for dynamic scope contributions: extra resolvable descriptions
 * layered at their declared tier within the scope `getScope` computes for
 * specific reference types. Split out of `DefaultAstExtensionService` so
 * the build-phase AST enrichment concern (which mutates nodes) is
 * separate from the query-time scope-resolution concern (which only reads).
 *
 * Lives in the per-language `references` group alongside `ScopeProvider`,
 * which consumes the per-tier query methods ({@link getLocalExtensionScope}
 * / {@link getUniversalExtensionScope}). Designed as a base class; adopters
 * extend it and call `register` in their constructor.
 */
export class DefaultScopeExtensionService implements ScopeExtensionService {
   protected readonly scopeExtensions = new Registry<ScopeExtension>();
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: ScopeExtensionServiceOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ScopeExtension').trace('instantiated');

      // Read the language's ScopeExtensionContribution group and let each
      // contribution register one or many scope extensions through this service.
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.references?.scopes ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerScopeExtensions(this);
      }
   }

   /**
    * Register a single scope extension. Doubles as the imperative low-level
    * API and as the {@link ScopeExtensionRegistry} entry point that
    * `ScopeExtensionContribution.registerScopeExtensions` hands to
    * contributions. Throws on duplicate id.
    */
   register(extension: ScopeExtension): Disposable {
      return this.scopeExtensions.register(extension);
   }

   getLocalExtensionScope(referenceType: string, context: AstNode, outerScope: Scope): Scope {
      const local = this.collectExtensionDescriptions(referenceType, context, 'local');
      if (local.length === 0) {
         return outerScope;
      }
      return new StreamScope(stream(local), outerScope);
   }

   getUniversalExtensionScope(referenceType: string, context: AstNode, outerScope: Scope): Scope {
      const universal = this.collectExtensionDescriptions(referenceType, context, 'universal');
      if (universal.length === 0) {
         return outerScope;
      }
      return new StreamScope(outerScope.getAllElements(), new MapScope(universal));
   }

   /**
    * Walk this language's registered scope extensions matching
    * `referenceType` and collect descriptions of the requested `tier`.
    * `push`-ed descriptions of other tiers are silently dropped here —
    * the per-tier query methods only return descriptions matching their
    * tier. (`local` and `universal` are the only acceptor entry points;
    * `push` is the escape hatch for pre-built descriptions and is the
    * only path that could carry other tiers.)
    */
   protected collectExtensionDescriptions(
      referenceType: string,
      context: AstNode,
      tier: 'local' | 'universal'
   ): TieredAstNodeDescription[] {
      const extensionsForType = this.scopeExtensions.all().filter(extension => extension.referenceTypes.includes(referenceType));
      if (extensionsForType.length === 0) {
         return [];
      }
      const document = AstUtils.getDocument(context);
      const collected: TieredAstNodeDescription[] = [];
      const accept = createScopeDescriptionAcceptor(collected, this.services.workspace.AstNodeDescriptionProvider);
      for (const extension of extensionsForType) {
         extension.addDescriptions(context, referenceType, document, accept);
      }
      return collected.filter(description => description.tier === tier);
   }
}
