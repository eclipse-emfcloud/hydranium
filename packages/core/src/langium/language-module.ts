/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type TransferElement } from '@hydranium/protocol';
import { type AstNode, type LangiumCoreServices, type Module } from '@hydranium/langium';
import { type LangiumServices, type PartialLangiumServices } from '@hydranium/langium/lsp';
import { type AstExtensionContribution } from './ast-extension/ast-extension-contribution.js';
import { type AstExtensionService, DefaultAstExtensionService } from './ast-extension/ast-extension-service.js';
import { HydraniumCommentProvider } from './documentation/comment-provider.js';
import { type IntegrityRuleContribution } from './integrity/integrity-contribution.js';
import { DefaultIntegrityService, type IntegrityService } from './integrity/integrity-service.js';
import { DefaultElementKeyProvider } from './keys/default-element-key-provider.js';
import { type ElementKeyProvider } from './keys/element-key-provider.js';
import { DefaultLabelProvider, type LabelProvider } from './labeling/label-provider.js';
import { DefaultNameProvider, type NameProvider } from './naming/name-provider.js';
import { NameSeparatorCheckContribution } from './naming/name-separator-validation.js';
import { HydraniumAstNodeDescriptionProvider } from './scope/ast-node-description-provider.js';
import { type ReferenceCandidateProvider, DefaultReferenceCandidateProvider } from './scope/reference-candidate-provider.js';
import { HydraniumScopeComputation } from './scope/hydranium-scope-computation.js';
import { HydraniumScopeProvider } from './scope/hydranium-scope-provider.js';
import { DefaultReferenceBuilder, type ReferenceBuilder } from './scope/reference-builder.js';
import { type ScopeExtensionContribution } from './scope/scope-extension-contribution.js';
import { DefaultScopeExtensionService, type ScopeExtensionService } from './scope/scope-extension-service.js';
import { type Serializer } from './serialization/serializer.js';
import { type UpdateRewriteContribution } from './update-rewrite/update-rewrite-contribution.js';
import { DefaultUpdateRewriteService, type UpdateRewriteService } from './update-rewrite/update-rewrite-service.js';
import { HydraniumDocumentValidator } from './validation/document-validator.js';
import { type ValidationCheckContribution } from './validation/validation-contribution.js';
import { ValidationContributionCollector } from './validation/validation-contribution-collector.js';
import { type ServerModuleContext, type ServerSharedServices } from './module.js';

/**
 * Language-level slots contributed by `@hydranium/core`. Bound by
 * {@link createServerLanguageModule}; consumer modules layered after
 * it can override any slot (later-wins, same composition idiom as the
 * shared-module side).
 *
 * Only contains slots every protocol head shares. LSP-textual-specific
 * bindings (e.g. `lsp.CompletionProvider`) belong to
 * `@hydranium/core/lsp`; GLSP-, data-, and other-head-specific
 * bindings live in their respective head packages.
 */
export interface ServerAddedServices {
   references: {
      ScopeComputation: HydraniumScopeComputation;
      ScopeProvider: HydraniumScopeProvider;
      /**
       * Cross-reference candidate provider — owns the candidate-side
       * completion pipeline (filter / dedupe / sort / build wire DTO).
       * Adopters subclass {@link DefaultReferenceCandidateProvider}
       * to override grammar-specific filters or label/value shaping.
       * Default binding registers
       * {@link DefaultReferenceCandidateProvider}.
       */
      CandidateProvider: ReferenceCandidateProvider;
      /**
       * The naming axis — names that change on rename. A re-typed extension
       * of Langium's `references.NameProvider` slot, bound by default to a
       * {@link DefaultNameProvider} exposing the framework's three
       * qualification levels ({@link NameProvider.getOwnName} /
       * {@link NameProvider.getDocumentQualifiedName} /
       * {@link NameProvider.getProjectQualifiedName}). Langium's linker and
       * scope read `getName` through this slot, which defaults to
       * `getProjectQualifiedName` (workspace-unique). Override to customise
       * naming; identity that must survive a rename belongs to
       * {@link ElementKeyProvider} instead.
       */
      /* override */ NameProvider: NameProvider;
      /**
       * The identity axis — stable identifiers that do NOT change on rename
       * (GModel ids, UI selection persistence). Exposes
       * {@link ElementKeyProvider.getElementKey} plus the hooks of the
       * resolving walk. A framework-only slot kept separate from
       * {@link NameProvider} so an adopter customises one axis without
       * disturbing the other.
       */
      ElementKeyProvider: ElementKeyProvider;
      /**
       * Labeling service — the UI axis (human-readable display strings),
       * sibling to {@link NameProvider} (the identifier axis). Read by the
       * candidate provider for completion labels and by adopter GModel
       * factories for diagram text. Default binding registers
       * {@link DefaultLabelProvider} (reads `labelProperties: ['name']`).
       */
      LabelProvider: LabelProvider;
      /**
       * Reference-construction service — turns (target, source) into the
       * `$refText` an author would type / a Langium `Reference`. The
       * construction dual of `ScopeProvider` / `CandidateProvider`
       * (which resolve references); reads names from {@link NameProvider} and
       * visibility from `ProjectManager`. Default binding registers
       * {@link DefaultReferenceBuilder}; adopters override
       * {@link DefaultReferenceBuilder.encodeRefText} for `$refText` escaping.
       */
      ReferenceBuilder: ReferenceBuilder;
      /**
       * Per-language dynamic scope contributions — extra resolvable
       * descriptions layered on top of the scope `getScope` computes. Read
       * by {@link HydraniumScopeProvider.getScope}; lives here alongside the
       * other scope-resolution services. The service reads its
       * `scopes` contribution group at construction.
       */
      ScopeExtensionService: ScopeExtensionService;
      /**
       * Declarative {@link ScopeExtensionContribution} group. Each sub-key
       * binds a contribution; the {@link ScopeExtensionService} iterates this
       * group at construction and calls each contribution's
       * `registerScopeExtensions(registry)`. Distinct sub-keys accumulate
       * across framework + adopter modules via Langium's deep-merge.
       * Same-keyed entries last-wins; the framework binds its own
       * contributions under a `framework` sub-key — adopters MUST avoid
       * that literal key.
       */
      scopes: Record<string, ScopeExtensionContribution>;
   };
   workspace: {
      /* override */ AstNodeDescriptionProvider: HydraniumAstNodeDescriptionProvider;
   };
   ast: {
      /**
       * Per-language build-phase AST enrichment (computed / synthetic
       * properties). Driven by the shared `BuildPipelineIntegration`
       * via `extendDocument`. The service reads its `extensions`
       * contribution group at construction.
       *
       * Lives in a purpose-named `ast` group rather than under `workspace`
       * (which holds Langium lifecycle concerns: WorkspaceManager,
       * DocumentBuilder, FileSystemProvider, AstNodeDescriptionProvider).
       * Matches the convention set by `references.ScopeExtensionService`
       * and `integrity.IntegrityService` — each registry lives in a group
       * named for its purpose.
       */
      AstExtensionService: AstExtensionService;
      /**
       * Declarative {@link AstExtensionContribution} group. Each sub-key
       * binds a contribution; the {@link AstExtensionService} iterates this
       * group at construction and calls each contribution's
       * `registerAstExtensions(registry)`. Distinct sub-keys accumulate
       * across framework + adopter modules via Langium's deep-merge.
       */
      extensions: Record<string, AstExtensionContribution>;
   };
   serializer: {
      /**
       * Typed home for grammar-specific round-trip serialisers.
       * `ModelService.serialize` resolves it via
       * `services.ServiceRegistry.getServices(uri).serializer.Serializer`, so
       * multi-grammar workspaces route to the right serializer per file. The
       * framework default throws a clear "no Serializer registered" error;
       * adopters bind their own per-language subclass to enable
       * `ModelService.update` / `ModelService.save`.
       */
      Serializer: Serializer;
   };
   integrity: {
      /**
       * Build-phase AST-integrity rule runner for this language. Framework
       * default is a no-op (zero rules registered) — adopters declare
       * their rules via {@link IntegrityRuleContribution}s under
       * `rules`, or via an `IntegrityService` subclass for
       * grammar-typed access (`IntegrityService<MyRoot>` is covariant in
       * `TRoot`, so the narrower subclass assigns to the
       * `IntegrityService<AstNode>` slot without a cast). The service
       * reads its `rules` contribution group at construction.
       * Driven by the shared `BuildPipelineIntegration`, which routes
       * each document to its own language's instance.
       */
      IntegrityService: IntegrityService<AstNode>;
      /**
       * Declarative {@link IntegrityRuleContribution} group. Each sub-key
       * binds a contribution; the {@link IntegrityService} iterates this
       * group at construction and calls each contribution's
       * `registerIntegrityRules(registry)`. Distinct sub-keys accumulate
       * across framework + adopter modules via Langium's deep-merge.
       */
      rules: Record<string, IntegrityRuleContribution>;
   };
   updateRewrite: {
      /**
       * Per-language runner for transfer-model rewrites applied on the
       * structured write path of `ModelService.update` / `save`, before
       * serialisation. The RPC-update-stage sibling of the
       * {@link IntegrityService} / {@link AstExtensionService} registries.
       * Framework default is a no-op (zero rewrites registered) — adopters
       * declare theirs via {@link UpdateRewriteContribution}s under
       * `rewrites`. Resolved per-URI by `ModelService`, so
       * multi-grammar workspaces route each write to the right rewrite set.
       */
      UpdateRewriteService: UpdateRewriteService;
      /**
       * Declarative {@link UpdateRewriteContribution} group. Each sub-key binds
       * a contribution; the {@link UpdateRewriteService} iterates this group at
       * construction and calls each contribution's
       * `registerUpdateRewrites(registry)`. Distinct sub-keys accumulate across
       * framework + adopter modules via Langium's deep-merge.
       *
       * The framework ships no member by default — notably
       * `NormalizeEmptyStringsContribution` is opt-in (it encodes a
       * grammar-specific "`''` means unset" assumption), registered by the
       * adopter under a named sub-key only when its form transport emits `''`.
       */
      rewrites: Record<string, UpdateRewriteContribution>;
   };
   validation: {
      /**
       * Per-language eager service that wires
       * {@link ValidationCheckContribution}s under `checks` into
       * Langium's `ValidationRegistry` at construction time. Constructed
       * on first per-language services access (typically forced by
       * `BuildPipelineIntegration`'s per-language routing helper
       * touching this slot before the first `Validated`-phase fire).
       */
      ValidationContributionCollector: ValidationContributionCollector;
      /**
       * Declarative {@link ValidationCheckContribution} group. Each sub-key
       * binds a contribution; the {@link ValidationContributionCollector}
       * iterates this group at construction and calls each contribution's
       * `registerValidationChecks(registry)`, where `registry` is a thin
       * adapter over Langium's `ValidationRegistry`. The framework binds
       * its own {@link NameSeparatorCheckContribution} under `framework`;
       * adopters bind their own contributions under named sub-keys. Two
       * contributions registering a check for the same node type both
       * fire — Langium's `ValidationRegistry` stores entries in a MultiMap.
       */
      checks: Record<string, ValidationCheckContribution>;
   };
}

/** Framework default — throws when either serializer entry point is invoked without an adopter binding. */
class UnboundSerializer implements Serializer {
   serializeAst(_model: AstNode): string {
      throw new Error(
         'No Serializer registered at services.serializer.Serializer — bind a Serializer<TAst, TTransfer> in your per-language module before calling ModelService.update / ModelService.save.'
      );
   }
   serializeTransfer(_model: TransferElement): string {
      throw new Error(
         'No Serializer registered at services.serializer.Serializer — bind a Serializer<TAst, TTransfer> in your per-language module before calling ModelService.update / ModelService.save.'
      );
   }
}

/**
 * Minimum per-language services tree every framework-bound class accepts
 * via its `services` constructor parameter.
 *
 * Langium's `LangiumCoreServices` (the LSP-free core surface) with two
 * framework refinements: `.shared` narrowed to {@link ServerSharedServices},
 * and the framework's own per-language additions
 * ({@link ServerAddedServices}). Bound classes therefore read framework
 * per-language slots like `this.services.ast.AstExtensionService` and
 * `this.services.references.NameProvider.getDocumentQualifiedName`
 * without a per-callsite cast.
 *
 * The only thing this type omits versus {@link ServerLanguageServices} is the
 * LSP-enabled `LangiumServices` surface — so use this narrower type when the
 * bound class does not consume LSP slots (the framework's own services are
 * NOT LSP slots and belong here).
 *
 * Adopters declaring per-language services trees should extend this, and
 * intersect their own narrower `shared`, so the framework's
 * `(services, options)` constructor surface accepts their service shape
 * without manual `.shared` casts.
 */
export type HydraniumLanguageServices = LangiumCoreServices &
   ServerAddedServices & {
      shared: ServerSharedServices;
   };

/**
 * Full language-service surface contributed by `createServerLanguageModule`.
 *
 * Extends {@link HydraniumLanguageServices} with the LSP-enabled
 * `LangiumServices` surface. The narrowed `.shared: ServerSharedServices` flows through from
 * `HydraniumLanguageServices` so framework-bound classes constructed at
 * the binding site (e.g. `services => new HydraniumScopeProvider(services)`)
 * see the framework-extended shared tree without a cast.
 *
 * Adopters whose per-language type intersects `LangiumServices &
 * ServerAddedServices & ...` must add `& { shared: <YourSharedServices> }`
 * so the type is assignable to `ServerLanguageServices` and the
 * framework's bound-class constructors accept it. An adopter does this
 * via a `/* override *\/ shared: <YourSharedServices>` declaration on its
 * per-language added-services interface.
 */
export type ServerLanguageServices = LangiumServices &
   ServerAddedServices & {
      shared: ServerSharedServices;
   };

/**
 * `@hydranium/core`'s default language module. Provides the head-neutral
 * bindings declared by {@link ServerAddedServices}; each protocol head
 * package layers its own language module after this one, as does the
 * adopter's.
 *
 * Order matters — `createServerLanguageModule` provides framework
 * defaults; later modules override (later-wins).
 */
export function createServerLanguageModule(
   _context: ServerModuleContext
): Module<ServerLanguageServices, PartialLangiumServices & ServerAddedServices> {
   return {
      references: {
         ScopeComputation: services => new HydraniumScopeComputation(services),
         ScopeProvider: services => new HydraniumScopeProvider(services),
         CandidateProvider: services => new DefaultReferenceCandidateProvider(services),
         NameProvider: services => new DefaultNameProvider(services),
         ElementKeyProvider: services => new DefaultElementKeyProvider(services),
         LabelProvider: services => new DefaultLabelProvider(services),
         ReferenceBuilder: services => new DefaultReferenceBuilder(services),
         ScopeExtensionService: services => new DefaultScopeExtensionService(services),
         scopes: {}
      },
      documentation: {
         // Read-side CST rehydration for hover/completion docs — a shed
         // target's preceding comment is resolved from its `$cstNode`, which
         // this provider restores on demand.
         CommentProvider: services => new HydraniumCommentProvider(services)
      },
      workspace: {
         AstNodeDescriptionProvider: services => new HydraniumAstNodeDescriptionProvider(services)
      },
      ast: {
         AstExtensionService: services => new DefaultAstExtensionService(services),
         extensions: {}
      },
      serializer: {
         Serializer: () => new UnboundSerializer()
      },
      // The per-URI serialise / re-parse path only fires when a rule mutates,
      // so the no-op default is safe even before adopters bind a real
      // serializer / parser.
      integrity: {
         IntegrityService: services => new DefaultIntegrityService(services),
         rules: {}
      },
      updateRewrite: {
         UpdateRewriteService: services => new DefaultUpdateRewriteService(services),
         rewrites: {}
      },
      validation: {
         // The framework validator on Langium's stock slot: it is what makes
         // `element`/`property` (the field a form client attaches an error to),
         // the `$synthetic` node skip and the virtual-document skip real.
         // Left at framework defaults on purpose — an adopter wanting other
         // option values rebinds the slot with its own `new
         // HydraniumDocumentValidator(services, { … })`.
         DocumentValidator: services => new HydraniumDocumentValidator(services),
         ValidationContributionCollector: services => new ValidationContributionCollector(services),
         checks: {
            // Flags name-bearing nodes whose name value contains the
            // configured name separator, so qualified names can never collide
            // with literal names. Adopters MUST avoid the `framework` sub-key
            // for their own contributions — Langium's deep-merge is last-wins
            // on same-key leaves, so replacing it drops this check.
            framework: services => new NameSeparatorCheckContribution(services)
         }
      }
   };
}
