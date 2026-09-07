/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer, type ReferenceCandidate, type ReferenceContext, type ReferenceRequest } from '@hydranium/protocol';
import {
   type AstNode,
   type AstNodeDescription,
   AstUtils,
   type LangiumDocument,
   type ReferenceInfo,
   type Scope,
   stream,
   type Stream,
   StreamScope
} from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { type LabelProvider } from '../labeling/label-provider.js';
import { type NameProvider } from '../naming/name-provider.js';
import { type HydraniumScopeProvider } from './hydranium-scope-provider.js';
import { dedupeTierSiblingsStream } from './tier-specificity.js';

/**
 * Reference info enriched with the source document and the source's
 * project id (when the framework's `ProjectManager` resolves one
 * for the document's URI). Returned by
 * {@link DefaultReferenceCandidateProvider.scopedReferenceInfo};
 * consumed by {@link DefaultReferenceCandidateProvider.filterCandidate}
 * so grammar-specific filters know which project is asking.
 * Adopters that carry richer source context (e.g. a data-model id)
 * extend this with additional fields.
 */
export interface ScopedReferenceInfo extends ReferenceInfo {
   /** The document declaring the source container. */
   document: LangiumDocument;
   /**
    * The project id of {@link document}'s owning project, or `undefined`
    * when no `ProjectManager` resolves a project for the document's URI
    * (e.g. a standalone file, or framework binding without a project
    * manager).
    */
   projectId: string | undefined;
}

/**
 * Result of {@link ReferenceCandidateProvider.getCandidateScope}:
 * the filtered + sorted scope plus the enriched source reference info
 * that produced it. Consumers read `elementScope.getAllElements()` for
 * ranked items and `source` for context-aware downstream filtering.
 *
 * Generic over the `source` shape so adopters that extend
 * {@link ScopedReferenceInfo} with richer context can return a
 * `CandidateScope<TheirShape>` from their `scopedReferenceInfo`
 * override without re-declaring the result interface.
 */
export interface CandidateScope<TSource extends ScopedReferenceInfo = ScopedReferenceInfo> {
   /** Ranked + deduped descriptions, filtered through {@link DefaultReferenceCandidateProvider.filterCandidate}. */
   elementScope: Scope;
   /** Source reference info used to compute the scope. */
   source: TSource;
}

/**
 * Resolution result handed back by
 * {@link ReferenceCandidateProvider.resolveCandidate}: the built
 * {@link ReferenceCandidate} for the matched target plus the resolved AST
 * node. In-process only (the `node` never crosses the wire) — the
 * data-server layer encodes the node into the wire `ReferenceTarget`.
 */
export interface ResolvedCandidate {
   /** Candidate descriptor (uri / type / label / value) for the resolved target. */
   candidate: ReferenceCandidate;
   /** The resolved AST node, for the data-server layer to encode as a transfer subtree. */
   node: AstNode;
}

/**
 * Reference candidate provider — owns the UI-facing completion pipeline
 * that turns a Langium scope into {@link ReferenceCandidate} DTOs for
 * command-palettes, drop-target action providers, completion popups, and
 * over-the-wire RPC consumers.
 *
 * Splits the four-stage pipeline (enrich source info → filter → dedupe
 * + sort → build DTO) cleanly off the scope provider, leaving
 * {@link HydraniumScopeProvider} focused on scope construction and
 * reference resolution. Dependency direction: candidate provider →
 * scope provider (uses `getScope`, `referenceContextToInfo`,
 * `sortText`, `resolveReference`); scope provider never depends on the
 * candidate provider, so the two services stay cycle-free.
 *
 * Adopters subclass one or the other based on which axis they want to
 * customise: source resolution / scope composition lives on
 * `HydraniumScopeProvider`; filter / display-name shaping lives on
 * {@link DefaultReferenceCandidateProvider}.
 */
export interface ReferenceCandidateProvider {
   /**
    * UI-facing entry point: returns the candidate scope's elements as
    * {@link ReferenceCandidate}s.
    */
   find(ctx: ReferenceContext): ReferenceCandidate[];

   /**
    * Build a ranked + deduped scope for candidate selection at the
    * given reference context. Accepts either a Langium
    * {@link ReferenceInfo} (for in-process callers that already have
    * one) or a protocol-layer {@link ReferenceContext} (for callers
    * wiring up from over-the-wire / synthetic contexts).
    */
   getCandidateScope(ctx: ReferenceContext | ReferenceInfo): CandidateScope;

   /**
    * Resolve a concrete {@link ReferenceRequest} to its target, returning
    * the built candidate plus the resolved node, or `undefined` when the
    * reference does not resolve. Uses the scope provider's resolution
    * scope (tier-siblings preserved, so a value resolves whether written
    * short or qualified), distinct from the collapsed candidate scope
    * {@link getCandidateScope} builds for listing.
    */
   resolveCandidate(ref: ReferenceRequest): ResolvedCandidate | undefined;
}

/**
 * Default implementation of {@link ReferenceCandidateProvider}.
 * Reads scope from a {@link HydraniumScopeProvider} and applies the
 * standard filter / dedupe / sort / build pipeline.
 *
 * Pipeline (in {@link getCandidateScope}):
 * 1. Enrich reference info via {@link scopedReferenceInfo} (adds
 *    `document` + `projectId`).
 * 2. Collect descriptions from the outer scope via
 *    `scopeProvider.getScope(referenceInfo)`.
 * 3. Filter via {@link filterCandidate} (framework default is a no-op;
 *    adopters add grammar-specific predicates).
 * 4. Collapse tier-siblings to the canonical tier via
 *    {@link applyCanonicalFilter}.
 * 5. Dedupe by `description.name` and sort by
 *    `scopeProvider.sortText`.
 * 6. Wrap in a {@link StreamScope}.
 *
 * The {@link find} method then maps each description through
 * {@link buildCandidate} to produce the wire DTO.
 *
 * Adopter override points:
 * - {@link scopedReferenceInfo} — extend `ScopedReferenceInfo` with
 *   richer source context.
 * - {@link filterCandidate} — grammar-specific candidate filters.
 * - {@link buildCandidate} — label / value separation for adopters
 *   whose UI surface needs a different display string from the
 *   persisted reference id. Default reads
 *   {@link LabelProvider.getLabel}, falling back to the
 *   description's bare name.
 */
export class DefaultReferenceCandidateProvider implements ReferenceCandidateProvider {
   protected readonly scopeProvider: HydraniumScopeProvider;
   protected readonly labelProvider: LabelProvider;
   /**
    * This language's own `NameProvider`, held for subclasses naming something
    * in the SOURCE document (the reference's own container, its owner). The
    * default candidate build uses {@link labelProvider} for labels, not this.
    *
    * For a CANDIDATE's node use {@link nameProviderFor} instead — a candidate
    * scope legitimately spans documents in other languages.
    */
   protected readonly nameProvider: NameProvider;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: LogNameOptions = {}
   ) {
      this.scopeProvider = services.references.ScopeProvider;
      this.labelProvider = services.references.LabelProvider;
      this.nameProvider = services.references.NameProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   /**
    * The `NameProvider` of the language that owns `target`'s document,
    * falling back to this language's when `target` routes nowhere.
    *
    * **A candidate's name is a fact about the candidate.** Which properties
    * carry it and how segments join are per-language (`nameProperties`,
    * `nameSeparator`), and a candidate scope spans every document a reference
    * could resolve to — including other grammars', since cross-language
    * references resolve through the global index. A subclass filter that
    * compares `description.name` against a name derived with THIS language's
    * provider therefore compares two different spellings of the same element
    * and never matches: a self-reference filter silently stops excluding, and
    * the element offers itself as its own target.
    *
    * The mirror of `ReferenceBuilder.nameProviderFor`, and the same fallback
    * reasoning: an unroutable target has no better answer than the source's.
    */
   protected nameProviderFor(target: AstNode): NameProvider {
      return this.services.shared.ServiceRegistry?.getServicesFor(target)?.references.NameProvider ?? this.nameProvider;
   }

   find(ctx: ReferenceContext): ReferenceCandidate[] {
      const scope = this.getCandidateScope(ctx);
      return scope.elementScope
         .getAllElements()
         .map<ReferenceCandidate>(description => this.buildCandidate(description, scope))
         .toArray();
   }

   getCandidateScope(ctx: ReferenceContext | ReferenceInfo): CandidateScope {
      const referenceInfo =
         'reference' in ctx ? this.scopedReferenceInfo(ctx) : this.scopedReferenceInfo(this.scopeProvider.referenceContextToInfo(ctx));
      const filtered = this.scopeProvider
         .getScope(referenceInfo)
         .getAllElements()
         .filter(description => this.filterCandidate(description, referenceInfo));
      const filteredDescriptions = this.applyCanonicalFilter(filtered)
         .distinct(description => description.name)
         .toArray()
         .sort((left, right) => this.scopeProvider.sortText(left).localeCompare(this.scopeProvider.sortText(right)));
      const elementScope = new StreamScope(stream(filteredDescriptions));
      return { elementScope, source: referenceInfo };
   }

   resolveCandidate(ref: ReferenceRequest): ResolvedCandidate | undefined {
      const node = this.scopeProvider.resolveReference(ref);
      if (!node) {
         return undefined;
      }
      return { candidate: this.buildResolvedCandidate(node, ref.value), node };
   }

   /**
    * Canonical filter — collapse the multiple descriptions a single node
    * emits across visibility tiers (multi-tier emission) down to the
    * most-specific tier-sibling per node, so a user sees one candidate
    * per node. Applied unconditionally in the candidate pipeline; adopters
    * needing the raw multi-tier set (debugging UIs, model-introspection
    * tooling) override to return the input unchanged.
    */
   protected applyCanonicalFilter<T extends AstNodeDescription>(candidates: Stream<T>): Stream<T> {
      return dedupeTierSiblingsStream(candidates);
   }

   /**
    * Enrich a Langium {@link ReferenceInfo} with the source document
    * and the source's project id. Project id resolution uses the
    * framework's `ProjectManager` bound at
    * `services.shared.workspace.ProjectManager`. Adopters with a
    * different project-ownership model (e.g. a custom project manager)
    * override to read their own manager.
    */
   protected scopedReferenceInfo(referenceInfo: ReferenceInfo): ScopedReferenceInfo {
      const document = AstUtils.getDocument(referenceInfo.container);
      const projectId = this.services.shared.workspace.ProjectManager.getProject(document.uri)?.id;
      return { ...referenceInfo, document, projectId };
   }

   /**
    * Per-description filter applied during {@link getCandidateScope}.
    * The framework default is a no-op pass-through that suppresses
    * nothing — tier-sibling collapsing is owned by
    * {@link applyCanonicalFilter} downstream. Adopters override with
    * grammar-specific predicates.
    */
   protected filterCandidate(_description: AstNodeDescription, _reference: ScopedReferenceInfo): boolean {
      return true;
   }

   /**
    * Build a {@link ReferenceCandidate} from an AST description
    * in the context of the surrounding candidate scope. Override hook
    * for adopters whose UI surface needs a different label / value
    * separation — a human-readable display string shown to the user
    * while the bare id is what gets persisted.
    *
    * Default behaviour: reads {@link LabelProvider.getLabel} from the
    * description's node and uses it as `label`, falling back to
    * `description.name` when there is no own label. Adopters with a
    * meaningful `labelProperties` get the display label in candidates
    * "for free" without overriding this method.
    */
   protected buildCandidate(description: AstNodeDescription, _scope: CandidateScope): ReferenceCandidate {
      const label = description.node ? (this.labelProvider.getLabel(description.node) ?? description.name) : description.name;
      return {
         uri: description.documentUri.toString(),
         type: description.type,
         label,
         value: description.name
      };
   }

   /**
    * Build a {@link ReferenceCandidate} for a resolved target node and the
    * value that resolved it. The node-based counterpart to
    * {@link buildCandidate} (which starts from a description in a list): the
    * resolve path holds the written `value` and the matched node, so `value`
    * is the request's value and `label` is the node's display name when it
    * differs. Adopters override alongside {@link buildCandidate} when they
    * shape labels specially.
    */
   protected buildResolvedCandidate(node: AstNode, value: string): ReferenceCandidate {
      const label = this.labelProvider.getLabel(node) ?? value;
      return {
         uri: AstUtils.getDocument(node).uri.toString(),
         type: node.$type,
         label,
         value
      };
   }
}
