/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Tracer,
   type ReferenceContext,
   type ReferenceRequest,
   type ReferenceSource,
   type SyntheticSource,
   isDocumentSource,
   isElementSource,
   isReferenceContext,
   isSyntheticSource
} from '@hydranium/protocol';
import {
   type AstNode,
   type AstNodeDescription,
   type AstNodeLocator,
   AstUtils,
   DefaultScopeProvider,
   MapScope,
   type ReferenceInfo,
   type Scope,
   type ScopeOptions,
   StreamScope,
   type URI,
   UriUtils,
   WorkspaceCache,
   stream
} from '@hydranium/langium';
import { buildAstNode } from '../ast-extension/ast-node-builder.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type NameProvider } from '../naming/name-provider.js';
import { type HydraniumDocumentRegistry } from '../workspace/langium-documents.js';
import { type ScopeExtensionService } from './scope-extension-service.js';
import { isTieredDescription } from './scoped-ast-node-description.js';

/**
 * Construction-time options for {@link HydraniumScopeProvider}. Extends
 * {@link LogNameOptions} so the standard `logName?` field
 * carries through.
 */
export interface HydraniumScopeProviderOptions extends LogNameOptions {
   /**
    * When `true`, own-project `'public'`-tier descriptions are visible
    * from within their owning project's resolution scope — i.e. the
    * own-project canonical filter is relaxed for public-tier descriptions
    * whose `projectId` matches the source's project.
    *
    * Adopters that use the project-qualified name as a reference form
    * within their own project enable this. Default `false` matches the
    * strict multi-tier emission pattern where the project-tier short name
    * is the canonical reference within the owning project.
    *
    * This affects the **resolution** scope only. The completion pipeline's
    * canonical filter (see `DefaultReferenceCandidateProvider` and
    * `HydraniumCompletionProvider`) independently collapses tier-siblings
    * to the canonical tier, so a user still sees one entry per node in
    * dropdowns even when this option is `true`.
    */
   readonly includeOwnProjectPublic?: boolean;
}

/**
 * Per-query context shared across the three sub-scope factory hooks of
 * {@link HydraniumScopeProvider}. Built once per scope build by
 * {@link HydraniumScopeProvider.makeScopeContext}, which walks the global
 * scope exactly once and partitions it into per-tier buckets via
 * {@link HydraniumScopeProvider.bucketFor}. The sub-scope hooks wrap their
 * bucket (or re-read {@link descriptions} to widen) without re-walking
 * the index.
 */
export interface ScopeContext {
   /** Owning project id of the source URI. */
   readonly sourceProjectId: string;
   /** Visibility closure of {@link sourceProjectId} (includes itself). */
   readonly visibleProjectIds: ReadonlySet<string>;
   /** Materialised global-scope descriptions for the queried reference type. */
   readonly descriptions: readonly AstNodeDescription[];
   /** Descriptions routed to the own-project tier (single-pass partition). */
   readonly ownProjectEntries: readonly AstNodeDescription[];
   /** Descriptions routed to the dependency-projects tier. */
   readonly dependencyEntries: readonly AstNodeDescription[];
   /** Descriptions routed to the universal tier. */
   readonly universalEntries: readonly AstNodeDescription[];
}

/**
 * Per-language scope provider that owns the full scope chain in ONE
 * class. Bridges the protocol-layer {@link ReferenceContext} to
 * Langium's {@link ReferenceInfo}, layers per-context scope-extension
 * contributions ({@link ScopeExtensionService}) at their declared tier,
 * and composes the cached project-tier chain (own-project → dependency
 * → universal) on top of Langium's unfiltered global index.
 *
 * ## Scope chain (high → low, inner shadows outer)
 *
 * ```
 *   document-local (Langium precomputed)        [DefaultScopeProvider.getScope]
 *     extension:local                           [layerLocalExtension, per-context]
 *       own-project → dependency → universal-index   [createGlobalScope default, CACHED per ${project}::${refType}]
 *         extension:universal                   [layerUniversalExtension, per-context, outermost]
 * ```
 *
 * Implementation: Langium's `getScope` layers document-local on top of
 * whatever `getGlobalScope` returns. The framework owns `getGlobalScope`
 * and uses it to assemble everything *below* document-local, with the
 * adopter-overridable {@link createGlobalScope} in the middle.
 *
 * ## Adopter override surface
 *
 * - **{@link createGlobalScope}** — the SINGLE level adopters override
 *   to change the per-context global/project scope. Because extension
 *   layering lives in framework-owned `getGlobalScope` outside
 *   `createGlobalScope`, an adopter's bypass cannot hide the extension
 *   layers.
 * - Tier-walk hooks ({@link makeScopeContext}, {@link bucketFor},
 *   {@link createOwnProjectScope}, {@link createDependencyScope},
 *   {@link createUniversalScope}, {@link chainScopes},
 *   {@link getProjectIdForDescription}) — override an individual tier
 *   without re-implementing the whole project-tier walk.
 * - Source-resolution hooks ({@link resolveSyntheticSource},
 *   {@link resolveRootElement}, {@link resolveElementByName}) — override
 *   individual cases of the `ReferenceSource` switch.
 * - **{@link createScopeForNodes}** — inherited from Langium and re-keyed by
 *   the framework to bare own-names, so it is the helper a `getScope`
 *   override uses to resolve a dotted member reference against a container
 *   the reference chain cannot reach.
 *
 * **Do NOT override `getGlobalScope` itself** — that is the framework's
 * extension-assembly seam. Overriding it would hide the scope-extension
 * layers behind your override.
 *
 * **Owns scope construction and reference resolution.** The complementary
 * candidate-side pipeline (filter / sort / dedupe / build wire DTO) lives
 * on `ReferenceCandidateProvider` in the sibling
 * `reference-candidate-provider.ts` module.
 */
export class HydraniumScopeProvider extends DefaultScopeProvider {
   protected readonly langiumDocuments: HydraniumDocumentRegistry;
   protected readonly astNodeLocator: AstNodeLocator;
   protected readonly scopeExtensionService: ScopeExtensionService;
   protected readonly options: HydraniumScopeProviderOptions;
   /**
    * Cache keyed by `${sourceProjectId}::${referenceType}`. Result is
    * the chained `project → public → universal` scope built from one
    * single-pass partition over the global index. Evicted by
    * Langium's `DocumentBuilder.onUpdate` (the `WorkspaceCache` default)
    * so any index change rebuilds.
    *
    * Per-language by design — the cache key already includes `refType`,
    * which is language-specific, so nothing is shared across languages
    * even though the `WorkspaceCache(services.shared)` instance evicts on
    * the workspace-global `DocumentBuilder.onUpdate`.
    */
   protected readonly scopeCache: WorkspaceCache<string, Scope>;
   protected readonly tracer: Tracer;
   /**
    * Narrows the inherited Langium {@link NameProvider} field to the framework's
    * {@link NameProvider} so call sites read `this.nameProvider.nameSeparator`
    * without a per-callsite cast. Bound by the framework's
    * `createServerLanguageModule` to a `DefaultNameProvider` subclass instance.
    */
   declare protected readonly nameProvider: NameProvider;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: HydraniumScopeProviderOptions = {}
   ) {
      super(services);
      this.langiumDocuments = services.shared.workspace.LangiumDocuments;
      this.astNodeLocator = services.workspace.AstNodeLocator;
      this.scopeExtensionService = services.references.ScopeExtensionService;
      this.options = options;
      this.scopeCache = new WorkspaceCache(services.shared);
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ScopeProvider').trace('instantiated');
   }

   /**
    * Framework-owned assembly seam. **Adopters do NOT override this** —
    * override {@link createGlobalScope} instead. This method layers the
    * scope-extension tiers around the adopter-overridable global scope.
    *
    * Langium's `DefaultScopeProvider.getScope` then layers document-local
    * on top of this result, yielding the full chain documented on the
    * class.
    */
   protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
      const projectChain = this.createGlobalScope(referenceType, context);
      const withUniversal = this.layerUniversalExtension(referenceType, context, projectChain);
      return this.layerLocalExtension(referenceType, context, withUniversal);
   }

   /**
    * The SINGLE adopter-overridable level of the project/global scope.
    * Adopters override to change the per-context global scope for
    * specific reference contexts — e.g. return `EMPTY_SCOPE` to suppress
    * the global scope entirely (so only document-local + extension:local
    * remain), or return a raw unfiltered scope to bypass the project-tier
    * filter for specific reference types.
    *
    * Default: builds the cached project-tier chain (own-project →
    * dependency → universal) on top of Langium's unfiltered global index,
    * keyed `${sourceProjectId}::${refType}` and evicted on workspace
    * update. Returns the input scope unchanged when:
    * - The source URI has no owning project (URIs outside any registered
    *   project folder).
    * - `ProjectManager.isSingleProject` reports `true` — the project
    *   filter would be a no-op in a single-project workspace (the
    *   synthetic workspace project owns everything, every tier is the
    *   source's own tier).
    *
    * Adopters bypassing the tier filter should call
    * {@link getAllElementsGlobalScope} to obtain the complete global
    * scope (every element of the requested type, regardless of tier
    * visibility), or `super.getGlobalScope` directly when even the
    * helper is too much indirection.
    */
   protected createGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
      const langiumGlobal = super.getGlobalScope(referenceType, context);
      const sourceUri = AstUtils.getDocument(context.container).uri;
      return this.getProjectScope(sourceUri, langiumGlobal, referenceType);
   }

   /**
    * Layer scope-extension `local`-tier descriptions on top of `inner`.
    * Returns `inner` unchanged when no extension contributes for the
    * reference type (zero-cost common path).
    */
   protected layerLocalExtension(referenceType: string, context: ReferenceInfo, inner: Scope): Scope {
      return this.scopeExtensionService.getLocalExtensionScope(referenceType, context.container, inner);
   }

   /**
    * Layer scope-extension `universal`-tier descriptions BELOW `inner`
    * (extensions appear last in the chain, shadowed by inner). Returns
    * `inner` unchanged when no extension contributes for the reference
    * type.
    */
   protected layerUniversalExtension(referenceType: string, context: ReferenceInfo, inner: Scope): Scope {
      return this.scopeExtensionService.getUniversalExtensionScope(referenceType, context.container, inner);
   }

   /**
    * Project-tier scope filter. Given a source URI and a global scope,
    * returns the subset of descriptions whose owning project is visible
    * from the URI's owning project — the project-dependency visibility
    * model. Cached per `${sourceProjectId}::${referenceType}`.
    *
    * `referenceType` is part of the cache key — separate scopes per
    * cross-reference type so name collisions across types don't shadow
    * each other in the chain.
    *
    * Public for adopter consumption: code outside the scope chain that
    * wants to apply the same project-tier filter to a custom scope (e.g.
    * a candidate provider's introspection mode) calls this method.
    */
   getProjectScope(sourceUri: URI, globalScope: Scope, referenceType: string): Scope {
      const projectManager = this.services.shared.workspace.ProjectManager;
      const sourceProjectId = projectManager.getProject(sourceUri)?.id;
      if (!sourceProjectId) {
         return globalScope;
      }
      if (projectManager.isSingleProject()) {
         return globalScope;
      }
      const cacheKey = `${sourceProjectId}::${referenceType}`;
      return this.scopeCache.get(cacheKey, () => this.buildProjectScope(sourceProjectId, globalScope));
   }

   /**
    * The complete global scope — every element of the requested
    * reference type that the workspace knows about, with no tier
    * filtering and no extension-layer composition. Use from inside a
    * {@link createGlobalScope} override when a specific context needs
    * to bypass the framework's project-tier visibility filter (e.g.
    * a self-referential cross-reference that must see all candidate
    * projects, including those outside the source's visibility
    * closure).
    *
    * Contrast {@link getGlobalScope}, which applies the framework's
    * tier filter to this set, and `getScope` (Langium default), which
    * additionally merges in the local scope.
    */
   protected getAllElementsGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
      return super.getGlobalScope(referenceType, context);
   }

   /**
    * Build the chained project scope from three tier sub-scopes. The
    * single scope walk happens once in {@link makeScopeContext}; the
    * sub-scope hooks classify the materialised array via {@link bucketFor}
    * (cheap in-memory filtering, no extra scope/index walk). Chained
    * inner-first so a more specific tier shadows a less specific one of
    * the same name: own-project → dependency-projects → universal.
    */
   protected buildProjectScope(sourceProjectId: string, globalScope: Scope): Scope {
      const context = this.makeScopeContext(sourceProjectId, globalScope);
      const ownScope = this.createOwnProjectScope(context);
      const dependencyScope = this.createDependencyScope(context);
      const universalScope = this.createUniversalScope(context);
      return this.chainScopes(ownScope, dependencyScope, universalScope);
   }

   /**
    * Build the per-query {@link ScopeContext}. Walks `globalScope` exactly
    * once (the one scope walk per cache miss) and partitions it into
    * per-tier buckets via a single pass over {@link bucketFor}, so the
    * untagged URI-lookup fallback runs at most once per description.
    */
   protected makeScopeContext(sourceProjectId: string, globalScope: Scope): ScopeContext {
      const visibleProjectIds = new Set(this.services.shared.workspace.ProjectManager.getVisibleProjects(sourceProjectId));
      const descriptions = globalScope.getAllElements().toArray();
      const ownProjectEntries: AstNodeDescription[] = [];
      const dependencyEntries: AstNodeDescription[] = [];
      const universalEntries: AstNodeDescription[] = [];
      for (const description of descriptions) {
         switch (this.bucketFor(description, sourceProjectId, visibleProjectIds)) {
            case 'project':
               ownProjectEntries.push(description);
               break;
            case 'public':
               dependencyEntries.push(description);
               break;
            case 'universal':
               universalEntries.push(description);
               break;
            case 'hidden':
               break;
         }
      }
      return { sourceProjectId, visibleProjectIds, descriptions, ownProjectEntries, dependencyEntries, universalEntries };
   }

   /**
    * Own-project sub-scope — descriptions in the source's own project.
    * Includes own-project `'public'`-tier descriptions when
    * {@link HydraniumScopeProviderOptions.includeOwnProjectPublic} is set
    * (routed to the own-project bucket by {@link bucketFor}). Returns a
    * {@link StreamScope} (not {@link MapScope}) so same-name siblings are
    * preserved rather than collapsed.
    */
   protected createOwnProjectScope(context: ScopeContext): Scope {
      return new StreamScope(stream(context.ownProjectEntries));
   }

   /**
    * Dependency-projects sub-scope — `'public'`-tier descriptions whose
    * owning project is reachable through the source's dependency closure
    * (own-project canonical filter applied by {@link bucketFor}).
    */
   protected createDependencyScope(context: ScopeContext): Scope {
      return new StreamScope(stream(context.dependencyEntries));
   }

   /**
    * Universal sub-scope — descriptions with no project association,
    * visible everywhere unconditionally.
    */
   protected createUniversalScope(context: ScopeContext): Scope {
      return new MapScope(context.universalEntries);
   }

   /**
    * Chain three tier sub-scopes inner-first. The `outerScope` argument
    * of {@link StreamScope} is consulted only when the inner stream has
    * no match, so a more specific tier shadows a less specific one of
    * the same name.
    */
   protected chainScopes(ownScope: Scope, dependencyScope: Scope, universalScope: Scope): Scope {
      return new StreamScope(ownScope.getAllElements(), new StreamScope(dependencyScope.getAllElements(), universalScope));
   }

   /**
    * Classify a description into one of three sub-scope buckets, or
    * `'hidden'` when it should not appear in the project-scope chain.
    *
    * Typed path (description carries `tier`):
    * - `'local'` → hidden (defensive — locals belong to per-document map)
    * - `'project'` → `'project'` iff `projectId === sourceProjectId`,
    *   else hidden (equality check)
    * - `'public'` → `'public'` iff `projectId !== sourceProjectId` AND
    *   `projectId` in source's visibility closure; own-project public is
    *   routed to `'project'` when
    *   {@link HydraniumScopeProviderOptions.includeOwnProjectPublic} is
    *   set, else hidden (own-project canonical filter + closure
    *   membership)
    * - `'universal'` → `'universal'` unconditionally
    *
    * Untagged path (no `tier` field) — preserved for backward-compat with
    * third-party Langium services emitting plain descriptions: URI →
    * project lookup via {@link getProjectIdForDescription}, then the same
    * bucketing rule.
    */
   protected bucketFor(
      description: AstNodeDescription,
      sourceProjectId: string,
      visibleProjectIds: ReadonlySet<string>
   ): 'project' | 'public' | 'universal' | 'hidden' {
      if (isTieredDescription(description)) {
         switch (description.tier) {
            case 'local':
               return 'hidden';
            case 'project':
               return description.projectId === sourceProjectId ? 'project' : 'hidden';
            case 'public':
               if (description.projectId === sourceProjectId) {
                  return this.options.includeOwnProjectPublic ? 'project' : 'hidden';
               }
               return description.projectId !== undefined && visibleProjectIds.has(description.projectId) ? 'public' : 'hidden';
            case 'universal':
               return 'universal';
         }
      }
      const projectId = this.getProjectIdForDescription(description);
      if (projectId === undefined) {
         return 'universal';
      }
      if (projectId === sourceProjectId) {
         return 'project';
      }
      if (visibleProjectIds.has(projectId)) {
         return 'public';
      }
      return 'hidden';
   }

   /**
    * Map a description to its owning project's id. Default: look up via
    * `ProjectManager.getProject(description.documentUri)`. A pure fallback
    * path — consulted only for descriptions carrying no `tier` field.
    */
   protected getProjectIdForDescription(description: AstNodeDescription): string | undefined {
      return this.services.shared.workspace.ProjectManager.getProject(description.documentUri)?.id;
   }

   /**
    * Keys the scope by {@link NameProvider.getOwnName} instead of Langium's
    * `getName`. Same correction `HydraniumScopeComputation.addLocalSymbol`
    * makes to the local-symbols pass, for the same reason: `getName` defaults
    * to the project-qualified form here, so the base would key a member scope
    * by the fully qualified `Container.member` while the reference text after
    * the dot is the bare `member` — and nothing reports the mismatch, because
    * the scope is non-empty and only the lookup misses.
    *
    * Callers building a member scope should leave `outerScope` unset: a
    * reference to a member the container does not have must fail rather than
    * fall through to a same-named member on an unrelated type.
    */
   protected override createScopeForNodes(elements: Iterable<AstNode>, outerScope?: Scope, options?: ScopeOptions): Scope {
      const descriptions = stream(elements)
         .map(node => {
            const name = this.nameProvider.getOwnName(node);
            // The framework's description provider stamps `tier: 'local'`, which
            // is correct here — these are constructed, never indexed.
            return name ? this.descriptions.createDescription(node, name, AstUtils.getDocument(node)) : undefined;
         })
         .nonNullable();
      return new StreamScope(descriptions, outerScope, options);
   }

   /**
    * Convert a protocol-layer {@link ReferenceContext} into a Langium
    * {@link ReferenceInfo} the rest of the scope/linking machinery accepts.
    *
    * Walks `syntheticPath` by FABRICATING a stub per step, so a scope can be
    * queried for an element that does not exist yet — which is what synthetic
    * paths are for. A stub carries the grammar's declared defaults and nothing
    * else, so its containment lists are present but EMPTY: a caller that needs
    * to read a populated collection off the leaf wants
    * {@link resolveReferenceSource} instead, which walks the same path into the
    * real tree.
    *
    * Throws if the context references an unresolvable source; callers
    * that prefer a soft failure should catch and fall back to
    * `EMPTY_SCOPE`.
    */
   referenceContextToInfo(ctx: ReferenceContext): ReferenceInfo {
      let container = this.resolveReferenceSource(ctx.source);
      if (!container) {
         throw new Error('Invalid reference source');
      }
      for (const step of ctx.syntheticPath ?? []) {
         container = buildAstNode(this.services.shared.AstReflection, step.type, {
            $container: container,
            $containerProperty: step.containerProperty,
            // Part of Langium's own container contract, so a stub that omits it
            // is an under-specified node: anything reading position off the
            // chain (a key provider, an adopter scope extension) sees
            // `undefined` where the caller named a slot.
            $containerIndex: step.index
         });
      }
      return {
         reference: { $refText: '', ref: undefined },
         container,
         property: ctx.property
      };
   }

   /**
    * Resolve a protocol-layer {@link ReferenceRequest} via the scope built for
    * its context. Returns `undefined` if the scope has no matching element or
    * if the description can't be resolved to a node.
    */
   resolveReference(reference: ReferenceRequest): AstNode | undefined {
      try {
         const referenceInfo = this.referenceContextToInfo(reference);
         const description = this.getScope(referenceInfo).getElement(reference.value);
         if (!description) {
            return undefined;
         }
         if (description.node) {
            return description.node;
         }
         const document = this.langiumDocuments.getDocument(description.documentUri);
         if (!document) {
            return undefined;
         }
         return this.astNodeLocator.getAstNode(document.parseResult.value, description.path);
      } catch {
         return undefined;
      }
   }

   /**
    * Resolve the SOURCE side of a reference — the element a query is asked
    * *from* — to a real node. Given a bare {@link ReferenceSource} it resolves
    * the anchor; given a whole {@link ReferenceContext} it continues along
    * `syntheticPath`, descending into the anchor's real children, and answers
    * the leaf.
    *
    * The counterpart to {@link resolveReference}, which resolves the other end:
    * that one answers what a reference POINTS AT, this one what the reference
    * is written ON. Distinct again from {@link referenceContextToInfo}, which
    * walks the same path but FABRICATES a type-only stub per step — the right
    * shape for a scope query, the wrong one for reading a collection off the
    * leaf, because a fabricated node has no children.
    *
    * A step addressing an array slot must carry `index`; without one the walk
    * stops rather than descending into the array itself, since an array is not
    * an `AstNode` and continuing would fail later somewhere unrelated. A step's
    * `type` is NOT verified against the child that was found — it names what
    * the caller expects, and narrowing on it would reject trees a permissive
    * adopter grammar allows.
    *
    * Answers `undefined` as soon as any step is missing.
    */
   resolveReferenceSource(source: ReferenceSource | ReferenceContext): AstNode | undefined {
      if (isReferenceContext(source)) {
         return this.resolveContextLeaf(source);
      }
      if (isSyntheticSource(source)) {
         return this.resolveSyntheticSource(source);
      }
      if (isDocumentSource(source)) {
         return this.resolveRootElement(UriUtils.toUri(source.uri));
      }
      if (isElementSource(source)) {
         return this.resolveElementByName(source.name, source.type);
      }
      return undefined;
   }

   /** Walk `syntheticPath` from the resolved anchor into real children. */
   protected resolveContextLeaf(ctx: ReferenceContext): AstNode | undefined {
      let node = this.resolveReferenceSource(ctx.source);
      for (const step of ctx.syntheticPath ?? []) {
         if (!node) {
            return undefined;
         }
         const slot: unknown = (node as unknown as Record<string, unknown>)[step.containerProperty];
         node = Array.isArray(slot)
            ? step.index === undefined
               ? undefined
               : (slot[step.index] as AstNode | undefined)
            : (slot as AstNode | undefined);
      }
      return node ?? undefined;
   }

   /**
    * Build a transient AST-node stub for a {@link SyntheticSource} request: a
    * node of the requested type, contained by the document at `source.uri`.
    *
    * **The container is materialised when no document is loaded there**, which
    * is the case the source type exists for — a `SyntheticSource` names a node
    * that does not exist yet, and the create-element flow asks at the FOLDER
    * the file is about to be written into. Abstaining there would answer an
    * empty candidate list, which a client cannot tell from "nothing matches".
    *
    * The stand-in parses under THIS provider's grammar, because a folder URI
    * carries no extension for the routing ladder to end on and this provider is
    * bound per grammar. Reaching for `createEmptyDocument(uri)` without the id
    * instead fails inside the parse, on an empty extension rather than on the
    * URI.
    *
    * The materialised document is unregistered and transient; see
    * `createEmptyDocument`. Overriding is still open to a consumer whose
    * "container" is an inner element rather than the parse root, or one that
    * deliberately declines to answer for an absent document.
    *
    * The stub carries the grammar's declared defaults, so an extension reading a
    * containment list off it sees an empty array rather than `undefined`.
    */
   protected resolveSyntheticSource(source: SyntheticSource): AstNode | undefined {
      const uri = UriUtils.toUri(source.uri);
      const document =
         this.langiumDocuments.getDocument(uri) ??
         this.langiumDocuments.createEmptyDocument(uri, this.services.LanguageMetaData.languageId);
      return buildAstNode(this.services.shared.AstReflection, source.type, { $container: document.parseResult.value });
   }

   /**
    * Resolve the semantic root node of the document at `uri`. Default: looks
    * up the document via `LangiumDocuments` and returns its parse-result root.
    * Consumers with a custom "semantic root" notion (i.e. an inner element
    * that is the meaningful root inside a wrapper grammar) override this.
    */
   protected resolveRootElement(uri: URI): AstNode | undefined {
      return this.langiumDocuments.getDocument(uri)?.parseResult.value;
   }

   /**
    * Resolve a node by **name**, given an optional reference type for
    * disambiguation.
    *
    * The contract on `name`:
    *
    * - It is a **qualified name** — the form a source-text writer would type,
    *   normally `NameProvider.getProjectQualifiedName`. Not a bare own-name,
    *   unless the adopter's naming scheme makes the two coincide.
    * - It is **not rename-stable.** Renaming the element changes its name and
    *   therefore this address. Callers holding an address across an edit must
    *   re-derive it.
    * - It is **distinct from the element key.** `ElementKeyProvider` produces a
    *   handle that round-trips to a node *within one document* (used for GModel
    *   ids and UI selection); this resolves a name against the whole workspace.
    *   Neither substitutes for the other, and there is no framework identifier
    *   that is both workspace-wide and rename-stable.
    *
    * Base implementation returns `undefined` — the framework does not decide
    * which qualification level an adopter's names carry. Adopters override,
    * typically by delegating to
    * `HydraniumIndexManager.resolveElementByName`, which resolves against
    * the `elementsByName` index that `HydraniumScopeComputation` populates.
    */
   protected resolveElementByName(_name: string, _type?: string): AstNode | undefined {
      return undefined;
   }

   /**
    * Sort key for the candidate provider's
    * `ReferenceCandidateProvider.getCandidateScope` pipeline. Default
    * prefixes the qualified-name segment count so local (bare-name)
    * entries surface before nested (`a.b.c`) entries, then sorts
    * lexicographically. Adopters whose name provider uses a non-default
    * separator inherit the default behaviour; adopters wanting a
    * different rank override.
    *
    * Public because the LSP `CompletionProvider` reads the same sort key
    * directly when assembling completion items, and the sibling candidate
    * provider in `reference-candidate-provider.ts` reads it during
    * its sort stage. Lives on the scope provider so both callers share
    * one implementation.
    */
   sortText(description: AstNodeDescription): string {
      return description.name.split(this.nameProvider.nameSeparator).length + '_' + description.name;
   }
}
