/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger, type Mutable, type Tracer } from '@hydranium/protocol';
import { type AstNode, AstUtils, DocumentState, type LangiumDocument } from '@hydranium/langium';
import type { CancellationToken, Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { Registry, type RegistryItem } from '../../util/registry.js';
import { type AstExtensionRegistry } from './ast-extension-contribution.js';

/**
 * A registration that derives data from an AST node and attaches it to the
 * node at a declared document-build phase.
 *
 * **Storage:** plain assignment (`node._foo = value`) is correct for primitives,
 * objects, and arrays of non-AstNode values — Langium's `streamContents` walks
 * own *enumerable* properties whose values are AstNodes (or arrays of them) and
 * skips everything else.
 *
 * **Synthetic children** (AstNode-shaped values that should *not* be walked as
 * containment children) must be assigned via {@link setHiddenProperty} so they
 * are stored as non-enumerable own properties. Otherwise symbol providers,
 * folding, semantic tokens, and validators will treat them as real children.
 *
 * **Phase semantics:** {@link state} declares the single phase at which
 * {@link compute} fires. The framework wires one `onDocumentPhase` listener per
 * useful state unconditionally, rather than deriving the set from the states
 * registrations declare — so a registration's state must be one of those, and
 * adding one is a framework change, not a registration-time choice.
 *
 * **`.ref`-dependent derivations: declare `state: ComputedScopes`, not `Linked`.**
 * Lazy reference resolution is available from `ComputedScopes` onward — the
 * global scope is built by `IndexedContent` (which runs before
 * `ComputedScopes`), so reading a reference's `.ref` inside a `ComputedScopes`
 * callback triggers Langium's lazy lookup and returns the resolved target node.
 *
 * **DO NOT** stage a `state: ComputedScopes` placeholder hoping to refine it
 * via a separate `state: Linked` registration when a downstream consumer
 * (typically a `ScopeExtension.addDescriptions` firing during link)
 * iterates the derived value to build a scope: `onDocumentPhase(Linked)` fires
 * AFTER Langium's `Linker.link()` has already walked the document, by which
 * time the linker has resolved references against the placeholder and cached
 * them as `LinkingError`. Populate at `ComputedScopes` via lazy `.ref`
 * resolution instead.
 *
 * **Description contribution.** This hook does not return descriptions — it
 * mutates the node only. Per-reference-type description contribution lives on
 * `ScopeExtension.addDescriptions` (the acceptor-style sibling).
 */
export interface AstExtension<T extends AstNode = AstNode> extends RegistryItem {
   /** Type-guard predicate — `compute` runs only on nodes for which this returns `true`. */
   nodeFilter: (node: AstNode) => node is T;
   /**
    * Per-document early-out. When set, the framework only invokes the
    * registration's callback for documents the filter accepts. If every
    * registration at a given state rejects the document, the framework skips
    * the `streamAllContents` walk entirely — important for large workspaces
    * where most documents carry none of the AST shapes a given extension
    * targets.
    *
    * Default: no filter (registration applies to every document at its state).
    */
   documentFilter?: (document: LangiumDocument) => boolean;
   /**
    * The single document-build state at which {@link compute} fires.
    *
    * Useful values:
    * - `Parsed` — derivations from AST shape only, no `.ref` reads.
    * - `ComputedScopes` — lazy `.ref` resolution available; the most common state.
    * - `Linked` — derivations needing fully resolved cross-references.
    * - `IndexedReferences` — cross-document reverse-lookup derivations.
    * - `Validated` — derivations depending on diagnostics (rare).
    *
    * Any other state type-checks but never fires: the framework wires a
    * listener only for the states above. `Changed` has no AST yet, and
    * `IndexedContent` carries the same per-document information as `Parsed`,
    * so neither is wired.
    */
   state: DocumentState;
   /**
    * Mutate `node` for this registration at {@link state}. The framework hands
    * `node` typed as {@link Mutable} so computed / synthetic property
    * assignments (`node._foo = ...`) compile without per-callback
    * `asMutable(...)` casts.
    *
    * Sync-only by Langium contract: `ScopeComputation.collectLocalSymbols`
    * iterates without awaiting, and `onDocumentPhase(ComputedScopes)` fires
    * right after — async work returned would resolve out of order vs the
    * local-symbol table read. Adopters needing async derivation must build
    * the data ahead of time and hand a sync callback.
    */
   compute(node: Mutable<T>, document: LangiumDocument): void;
}

/**
 * Public contract for the per-language AST-extension service. Extends the
 * {@link AstExtensionRegistry} (the imperative `register` surface
 * contributions use) with the dispatch entry points. Only
 * {@link AstExtensionService.extendDocument} is called cross-class from
 * `BuildPipelineIntegration`, as documents reach each wired phase;
 * {@link AstExtensionService.extendNode} has no production caller.
 *
 * Adopter overrides go through {@link DefaultAstExtensionService}; the
 * interface keeps the public API stable while internals (the bucket-
 * by-state cache) stay `protected` on the default class.
 */
export interface AstExtensionService extends AstExtensionRegistry {
   /**
    * Run a single AST node through every registration declaring
    * `phase` as its state. Honours `documentFilter` and `nodeFilter`.
    * Primarily for tests that need to invoke an extension callback without
    * driving Langium's full document-build pipeline.
    */
   extendNode(node: AstNode, document: LangiumDocument, phase: DocumentState): void;
   /**
    * Re-run all `compute` callbacks declaring `phase` as their state against
    * every node in the document. Single-pass. Called by
    * `BuildPipelineIntegration` from an `onDocumentPhase` listener;
    * not for general adopter use.
    */
   extendDocument(document: LangiumDocument, phase: DocumentState, cancelToken?: CancellationToken): void;
}

/** Construction options for {@link DefaultAstExtensionService}. */
export type AstExtensionServiceOptions = LogNameOptions;

/**
 * Default {@link AstExtensionService} implementation. Generic registry for
 * build-phase AST-node enrichment: computed properties and synthetic
 * children. The sibling scope-contribution concern (extra resolvable
 * descriptions at query time) lives in `ScopeExtensionService`.
 *
 * Designed as a base class; consumers extend it and call `register` in
 * their constructor.
 *
 * Build-phase invocation is driven by `BuildPipelineIntegration`,
 * which calls {@link extendDocument} for the wired phases — this class
 * owns the registry + per-node logic, not the listener lifecycle.
 *
 * **Performance:** `extendDocument` shares a single `streamAllContents` walk
 * per document per wired phase; cost is O(registrations-for-state × nodes),
 * and it early-outs when no registration targets the state or the document.
 */
export class DefaultAstExtensionService implements AstExtensionService {
   protected readonly extensions = new Registry<AstExtension>();
   /**
    * Per-state bucket of registrations targeting each state. Rebuilt lazily
    * on the first refresh after a registry mutation — staleness is detected
    * via reference identity of the registry's cached array (see {@link Registry.all}).
    */
   protected stateBuckets = new Map<DocumentState, readonly AstExtension[]>();
   protected stateBucketsFor: readonly AstExtension[] | undefined;

   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: AstExtensionServiceOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'AstExtension').trace('instantiated');

      // Read the language's AstExtensionContribution group and let each
      // contribution register one or many extensions through this service.
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.ast?.extensions ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerAstExtensions(this);
      }
   }

   /**
    * Register a single AST extension. Doubles as the imperative low-level
    * API and as the {@link AstExtensionRegistry} entry point that
    * `AstExtensionContribution.registerAstExtensions` hands to
    * contributions. Throws on duplicate id.
    *
    * Build-phase invocation is driven by `BuildPipelineIntegration`,
    * which calls {@link extendDocument} for the wired phases.
    */
   register<T extends AstNode>(extension: AstExtension<T>): Disposable {
      // Cast: TypeScript can't see that `T extends AstNode` makes the extension
      // assignable to the default-parameter form. The runtime contract is the same.
      return this.extensions.register(extension as AstExtension);
   }

   /**
    * Production code goes through {@link extendDocument} via the
    * `onDocumentPhase(state)` listener wired by `BuildPipelineIntegration`.
    */
   extendNode(node: AstNode, document: LangiumDocument, phase: DocumentState): void {
      const bucket = this.getStateBucket(phase);
      for (const extension of bucket) {
         if (extension.documentFilter && !extension.documentFilter(document)) {
            continue;
         }
         if (!extension.nodeFilter(node)) {
            continue;
         }
         extension.compute(node as Mutable<AstNode>, document);
      }
   }

   /**
    * Skips the walk entirely when no registration applies to this document
    * (either no registration declares `phase`, or every applicable
    * registration's `documentFilter` rejects the document).
    *
    * `cancelToken` is checked at entry — `onDocumentPhase` is invoked once per
    * document by Langium, so an entry-check skips the `streamAllContents`
    * walk for any document arriving after the build is preempted. The
    * per-registration / per-node loops stay sync (no inner `interruptAndCheck`)
    * to avoid async coloring through the property-walk callbacks; the
    * downstream throughput hit from running one extra document's walk is
    * smaller than the microtask cost of yielding inside the walk.
    */
   extendDocument(document: LangiumDocument, phase: DocumentState, cancelToken?: CancellationToken): void {
      if (cancelToken?.isCancellationRequested) {
         return;
      }
      const bucket = this.getStateBucket(phase);
      if (bucket.length === 0) {
         return;
      }
      // Per-document filter: registrations without `documentFilter` always apply.
      // If every registration rejects the document, skip the streamAllContents walk.
      const applicable = bucket.filter(extension => !extension.documentFilter || extension.documentFilter(document));
      if (applicable.length === 0) {
         return;
      }
      // Per-registration self-time profiling is opt-in: only open a session when
      // the debug threshold is active, so the production path allocates nothing
      // and the per-(node×registration) loop stays a single const-branch off
      // `session`. `ProfileSession.scope` is NOT itself level-gated.
      const session = Logger.isLevelEnabled('debug') ? this.tracer.profile(`ast-extension ${DocumentState[phase]}`) : undefined;
      for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
         for (const extension of applicable) {
            if (extension.nodeFilter(node)) {
               // Scope per registration id so the session aggregates self-time by
               // extension across every node; off the profiling path call directly.
               if (session) {
                  session.scope(extension.id, () => extension.compute(node as Mutable<AstNode>, document));
               } else {
                  extension.compute(node as Mutable<AstNode>, document);
               }
            }
         }
      }
      // One line per registration (count + self-% + self-ms), sorted — only when profiling.
      session?.report('debug');
   }

   /**
    * Bucket-by-state view of {@link extensions}, rebuilt lazily when the
    * registry's cached `all()` reference changes. Replaces per-call allocation
    * on the per-node hot path — for a workspace with many documents at the
    * same state, the bucket is computed once and reused until the next
    * register / unregister.
    */
   protected getStateBucket(phase: DocumentState): readonly AstExtension[] {
      const current = this.extensions.all();
      if (this.stateBucketsFor !== current) {
         const next = new Map<DocumentState, AstExtension[]>();
         for (const extension of current) {
            let bucket = next.get(extension.state);
            if (!bucket) {
               bucket = [];
               next.set(extension.state, bucket);
            }
            bucket.push(extension);
         }
         this.stateBuckets = next;
         this.stateBucketsFor = current;
      }
      return this.stateBuckets.get(phase) ?? EMPTY_STATE_BUCKET;
   }
}

/** Shared empty result so `getStateBucket` doesn't allocate per call on the cold path. */
const EMPTY_STATE_BUCKET: readonly AstExtension[] = Object.freeze([]);

/**
 * Assign a non-enumerable own property — for synthetic children that must NOT
 * be walked by Langium's `streamContents`.
 *
 * Direct reads (`node._foo`) still work. In its default `full` transfer mode
 * the encoder enumerates via `Object.getOwnPropertyNames`, so the property
 * still crosses to the wire shape; `grammar` mode enumerates the reflection's
 * declared-property allowlist instead and therefore drops it.
 *
 * Use when assigning AstNode-shaped values that should not appear as
 * containment children to symbol providers, folding, semantic tokens, or
 * validators. Plain non-AstNode values (strings, booleans, plain objects) can
 * be assigned with `node._foo = value` directly — Langium's iteration only
 * yields AstNode-shaped values, so non-AST data is naturally invisible.
 */
export function setHiddenProperty<V>(node: object, property: string, value: V): void {
   Object.defineProperty(node, property, {
      value,
      writable: true,
      configurable: true,
      enumerable: false
   });
}
