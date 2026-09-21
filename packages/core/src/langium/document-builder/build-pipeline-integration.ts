/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, DocumentState } from '@hydranium/langium';
import { type CancellationToken } from 'vscode-languageserver';
import { IntegrityPhase } from '../integrity/integrity-rule.js';
import { groupDocumentsByLanguage } from '../build-phase-pass/build-phase-pass.js';
import { type ServerSharedServices } from '../module.js';
import { labelPhaseListener } from './labeled-phase-listener.js';

/**
 * AST extension wiring covers every "useful" `DocumentState` an extension can
 * target. `Changed` has no AST yet; `IndexedContent` carries the same
 * per-document information as `Parsed`. No-op fires for documents with no
 * extension at a given state are negligible (`notifyDocumentPhase` is a plain
 * listener loop), so the framework wires the full set unconditionally rather
 * than collecting declared states from per-language registrations.
 */
const AST_EXTENSION_PHASES: readonly DocumentState[] = [
   DocumentState.Parsed,
   DocumentState.ComputedScopes,
   DocumentState.Linked,
   DocumentState.IndexedReferences,
   DocumentState.Validated
];

/**
 * Build phases at which the `BuildPhasePassService` is driven. A pass
 * registered at any other state never fires (the listener is not wired), and
 * `runPasses` no-ops at a phase with no registered pass, so wiring the full set
 * unconditionally costs only an empty-bucket check per phase.
 *
 * `IndexedContent` belongs here and NOT in {@link AST_EXTENSION_PHASES}, so the
 * two cannot be collapsed. Per document it carries nothing `Parsed` does; per
 * BATCH it is the only phase meaning the global index is whole again, which
 * batch work keyed on a complete index has nowhere else to run.
 */
const BUILD_PHASE_PASS_STATES: readonly DocumentState[] = [
   DocumentState.Parsed,
   DocumentState.IndexedContent,
   DocumentState.ComputedScopes,
   DocumentState.Linked,
   DocumentState.IndexedReferences,
   DocumentState.Validated
];

/**
 * Default priority of the framework integrity passes. Integrity mutates / cleans
 * the AST that every derived-state pass reads, so it is *foundational* and must
 * run before adopter passes. It sits in a NEGATIVE band for that reason: a pass
 * registered with no explicit priority defaults to `0` (see `RegistryItem.priority`),
 * and the framework integrity pass registers AFTER adopter contributions (which
 * register at `BuildPhasePassService` construction), so a `0`-vs-`0` tie would
 * break by registration order and let the adopter run first. The negative band
 * makes integrity precede default-priority adopter passes regardless of
 * registration order. Adopter passes that must run after integrity use `0` or
 * higher. See {@link BuildPipelineIntegrationOptions} to override.
 */
export const INTEGRITY_PASS_PRIORITY = -1000;

/**
 * Default priority of the framework scope-cache pass. In the NEGATIVE
 * foundational band for the reason {@link INTEGRITY_PASS_PRIORITY} gives: an
 * adopter pass at `IndexedContent` takes the default `0`, and one running first
 * reads scopes built from the mid-rebuild index. Sharing that constant's value
 * is not sharing its knob — priority orders passes only within one phase
 * bucket, and integrity registers at no phase this pass runs at.
 */
export const SCOPE_CACHE_PASS_PRIORITY = -1000;

/** Construction options for {@link BuildPipelineIntegration}. */
export interface BuildPipelineIntegrationOptions {
   /**
    * Priority of the framework integrity passes, applied at every
    * {@link IntegrityPhase}. A single value covers all integrity phases: priority
    * only orders passes WITHIN one phase bucket, and integrity at `Parsed` vs
    * `Linked` lives in different buckets, so per-phase values would never
    * interact. Default {@link INTEGRITY_PASS_PRIORITY}.
    */
   readonly integrityPriority?: number;
}

/**
 * The build-pipeline slot. Empty because nothing calls this service — it wires
 * itself in its constructor and every seam it offers is `protected`.
 *
 * Typing the slot by the class instead would stop an adopter's subclass
 * satisfying it, since a class carries its `protected` members into the check
 * and they compare by declaration rather than by shape. The cost of the empty
 * shape is that any non-null value satisfies it, so a mis-bound slot compiles
 * and the framework's phase listeners are then never attached.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the slot has no public member to name
export interface BuildPipelineIntegration {}

/**
 * Wires the framework's build-time features (integrity rules, AST
 * enrichment) into Langium's document-build pipeline. The single shared
 * place that subscribes to the document builder's phase notifications and,
 * at each phase, drives the relevant feature service for each document —
 * so the feature services stay pure registries with no lifecycle code.
 *
 * **Build-phase vs document-phase.** The method name carries both the
 * phase and the notification family:
 * - `onDocument<Phase>` — fires per document, as each one reaches the
 *   phase (interleaved with the rest of the batch still building). Used
 *   for independent, read-only per-document derivation → AST enrichment.
 * - `onBuild<Phase>` — fires once, after the whole batch has reached the
 *   phase. Used when work needs the batch settled or mutates/regresses
 *   document state → integrity (mutates the AST + reparses).
 *
 * Adopters subclass to change *how* a feature is invoked by overriding one
 * protected per-feature helper — {@link callIntegrity} (integrity enforcement),
 * {@link extendAst} (per-document AST enrichment), or {@link runBuildPhase}
 * (batch-level build-phase pass dispatch) — or to wire an additional phase
 * (override the constructor).
 *
 * Eagerly constructed (via `DEFAULT_EAGER_SERVICES`) so the listeners are
 * attached before the first build cycle.
 */
export class DefaultBuildPipelineIntegration implements BuildPipelineIntegration {
   constructor(
      protected readonly services: ServerSharedServices,
      options: BuildPipelineIntegrationOptions = {}
   ) {
      const builder = services.workspace.DocumentBuilder;
      const passes = services.workspace.BuildPhasePassService;

      // Framework integrity, registered as batch-level passes rather than direct
      // onBuildPhase listeners — so it shares ONE priority space with adopter
      // passes and the ordering between them is declared, not left to DI
      // construction order. One pass per IntegrityPhase (the canonical allowed
      // set, shared with the register guard); `callIntegrity` fans out
      // per-language internally.
      const integrityPriority = options.integrityPriority ?? INTEGRITY_PASS_PRIORITY;
      for (const phase of IntegrityPhase.all()) {
         passes.register({
            id: `framework:integrity:${IntegrityPhase.toString(phase).toLowerCase()}`,
            state: phase,
            priority: integrityPriority,
            run: (documents, cancelToken) => this.callIntegrity(documents, phase, cancelToken)
         });
      }

      // A pass rather than a listener each scope provider registers for itself,
      // so an adopter pass at this phase is ordered against it by declaration
      // instead of by DI construction order. `clearScopeCaches` carries why the
      // caches' own eviction does not cover this.
      passes.register({
         id: 'framework:scope-cache:indexed-content',
         state: DocumentState.IndexedContent,
         priority: SCOPE_CACHE_PASS_PRIORITY,
         run: () => this.clearScopeCaches()
      });

      // One onBuildPhase listener per pass state, routed through the overridable
      // `runBuildPhase` seam → priority-ordered, sequential, cancel-aware pass
      // dispatch. The returned promise is awaited by the build pipeline, so a
      // mutating pass (integrity) reparses before the build advances.
      for (const phase of BUILD_PHASE_PASS_STATES) {
         builder.onBuildPhase(
            phase,
            labelPhaseListener(
               (documents, cancelToken) => this.runBuildPhase(documents, phase, cancelToken),
               `BuildPipeline.runBuildPhase.${DocumentState[phase]}`
            )
         );
      }

      // AST enrichment stays per-document (onDocumentPhase) and node-granular —
      // unchanged by the build-phase-pass registry, which is batch-granular. The
      // listener calls the `extendAst` seam directly (the document-phase analog of
      // `runBuildPhase`); there is no per-phase handler tier — one parameterized seam.
      for (const phase of AST_EXTENSION_PHASES) {
         builder.onDocumentPhase(
            phase,
            labelPhaseListener(
               (document, cancelToken) => this.extendAst(document, phase, cancelToken),
               `BuildPipeline.extendAst.${DocumentState[phase]}`
            )
         );
      }
   }

   // ============================================================
   // Feature seams — one overridable helper per framework feature
   // ============================================================

   /**
    * Run integrity enforcement for the batch at `phase`. The batch may span
    * grammars, so group documents by their language's `IntegrityService`
    * and enforce each group — preserving the per-language batch timing log.
    *
    * As a side effect of resolving each document's language services tree,
    * this routing helper also forces construction of that language's
    * `ValidationContributionCollector` — so validation checks declared
    * via `validation.checks` contributions are registered into the
    * `ValidationRegistry` before Langium reaches the `Validated` phase.
    */
   protected async callIntegrity(
      documents: readonly LangiumDocument[],
      phase: DocumentState,
      cancelToken: CancellationToken
   ): Promise<void> {
      // The same fan-out `groupDocumentsByLanguage` offers adopter passes —
      // shared rather than parallel, so the exported helper is proven by the
      // framework's own use of it rather than only by its tests.
      for (const [languageServices, group] of groupDocumentsByLanguage(this.services, documents)) {
         // Force construction of the language's ValidationContributionCollector
         // on first touch; cached by Langium's DI proxy after that.
         void languageServices.validation.ValidationContributionCollector;
         await languageServices.integrity.IntegrityService.enforceBatch(group, phase, cancelToken);
      }
   }

   /**
    * Drop the cached scopes of every REGISTERED language, not of those owning a
    * document in the batch. The index a scope is built from is
    * workspace-global, so narrowing to the batch with
    * {@link groupDocumentsByLanguage}, the way {@link callIntegrity} does,
    * leaves a cross-grammar reference resolving against a mid-rebuild scope.
    */
   protected clearScopeCaches(): void {
      for (const languageServices of this.services.ServiceRegistry.all) {
         languageServices.references.ScopeProvider.clearScopeCaches();
      }
   }

   /** Run AST enrichment for a single document at `phase` via its language service. */
   protected extendAst(document: LangiumDocument, phase: DocumentState, cancelToken: CancellationToken): void {
      this.services.ServiceRegistry.getServices(document.uri).ast.AstExtensionService.extendDocument(document, phase, cancelToken);
   }

   /**
    * Dispatch every build-phase pass registered at `phase`, in priority order. The
    * overridable seam between the `onBuildPhase` listener and the shared
    * `BuildPhasePassService`: adopters subclass to gate, instrument, or wrap
    * the batch-level pass run (the build-phase analog of {@link extendAst} for the
    * document-phase AST run). Returns the dispatch promise so the build pipeline
    * awaits a mutating pass (integrity) before advancing.
    */
   protected runBuildPhase(documents: readonly LangiumDocument[], phase: DocumentState, cancelToken: CancellationToken): Promise<void> {
      return this.services.workspace.BuildPhasePassService.runPasses(documents, phase, cancelToken);
   }
}
