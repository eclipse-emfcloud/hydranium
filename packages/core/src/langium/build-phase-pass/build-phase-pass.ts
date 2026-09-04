/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type DocumentState, type LangiumCoreServices, type LangiumDocument, type URI } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type RegistryItem } from '../../util/registry.js';

/**
 * A unit of whole-batch work run once per build when the batch reaches a
 * declared build phase, ordered by {@link RegistryItem.priority}.
 *
 * **Granularity.** This is the batch-level (`documents[]`) sibling of the
 * node-level registries `AstExtension` (per node, `onDocumentPhase`) and
 * `IntegrityRule` (per node, dispatched from a framework-registered pass of this
 * kind). A `BuildPhasePass` rides Langium's native `onBuildPhase` signature
 * directly — it is handed the whole built batch and owns its own walk, for work
 * that needs cross-document ordering, rather than having the framework drive a
 * per-node `streamAllContents` walk.
 *
 * **Ordering.** {@link RegistryItem.priority} orders passes WITHIN one phase,
 * never across phases, because each phase has its own bucket. Lower runs first;
 * ties break by registration order. Passes in a bucket run sequentially — each
 * is awaited before the next begins. This is the framework's single declared
 * insertion point for build-phase work: an adopter pass that must run after a
 * framework pass declares a higher priority instead of relying on DI
 * construction order.
 *
 * **Priority bands.** `priority` defaults to `0` ({@link RegistryItem.priority}).
 * The framework reserves NEGATIVE priorities for *foundational* passes that must
 * precede adopter work regardless of registration order — notably integrity
 * (`INTEGRITY_PASS_PRIORITY`), which cleans/mutates the AST every derived-state
 * pass reads. Adopter passes therefore use `0` or higher, which puts them after
 * the foundational band without declaring anything; chained adopter passes order
 * among themselves with increasing values. Adopters do NOT need a negative
 * priority — that band is the framework's.
 *
 * **Async + cancellation.** {@link run} may be sync or async; an async pass is
 * awaited so the next pass sees its full effect. The dispatcher checks the
 * cancel token before each pass, so a build preempted mid-phase stops cleanly
 * rather than running the remaining passes against a doomed build.
 */
export interface BuildPhasePass extends RegistryItem {
   /**
    * The single build phase whose `onBuildPhase` fires this pass. The framework
    * wires a listener for the same phase set as AST extension; a pass declaring
    * any other state type-checks but never fires.
    */
   state: DocumentState;
   /**
    * Run this pass against the whole built batch. May mutate and reparse
    * documents — the framework's integrity pass does — or derive cross-document
    * state. Honour `cancelToken` for long walks; the dispatcher already checks
    * it between passes.
    */
   run(documents: readonly LangiumDocument[], cancelToken: CancellationToken): void | Promise<void>;
}

/**
 * Group a build batch by the language that owns each document, preserving the
 * batch's order within each group.
 *
 * **Why a pass needs this.** A {@link BuildPhasePass} is handed the whole batch
 * with no language dimension — unlike its node-level siblings `AstExtension`
 * and `IntegrityRule`, which the framework resolves per document before calling
 * them. In a single-grammar workspace that difference is invisible. In a
 * multi-grammar one, a pass that reaches for `services.language.<anything>`
 * silently applies the FIRST language's services to every document in the
 * batch, including documents of the other grammar; nothing errors, and the
 * result is derived state computed against the wrong grammar's rules.
 *
 * Documents whose URI matches no registered language are omitted — a pass
 * cannot meaningfully run a language's services over them, and throwing would
 * fail the whole build over one stray URI.
 */
export function groupDocumentsByLanguage<TLanguage extends LangiumCoreServices>(
   services: { ServiceRegistry: { hasServices(uri: URI): boolean; getServices(uri: URI): TLanguage } },
   documents: readonly LangiumDocument[]
): Map<TLanguage, LangiumDocument[]> {
   const grouped = new Map<TLanguage, LangiumDocument[]>();
   for (const document of documents) {
      if (!services.ServiceRegistry.hasServices(document.uri)) {
         continue;
      }
      const language = services.ServiceRegistry.getServices(document.uri);
      const group = grouped.get(language);
      if (group) {
         group.push(document);
      } else {
         grouped.set(language, [document]);
      }
   }
   return grouped;
}

/**
 * Registry handed to a {@link BuildPhasePassContribution}. Implemented by the
 * `BuildPhasePassService`; doubles
 * as the low-level imperative API the framework uses to self-register its own
 * passes (integrity, the Langium profiler flush).
 */
export interface BuildPhasePassRegistry {
   register(pass: BuildPhasePass): Disposable;
}

/**
 * Declarative registration of build-phase passes. Bound under the shared
 * module's `buildPhasePasses` contribution group; the
 * `BuildPhasePassService` reads its
 * own group at construction and calls this method, handing itself in as the
 * registry.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface BuildPhasePassContribution {
   registerBuildPhasePasses(registry: BuildPhasePassRegistry): void;
}
