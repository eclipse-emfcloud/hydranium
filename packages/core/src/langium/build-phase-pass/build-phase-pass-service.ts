/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger, type Tracer } from '@hydranium/protocol';
import { DocumentState, type LangiumDocument } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServices } from '../module.js';
import { Registry } from '../../util/registry.js';
import { type BuildPhasePass, type BuildPhasePassRegistry } from './build-phase-pass.js';

/**
 * Public contract for the shared build-phase-pass runner. Extends the
 * {@link BuildPhasePassRegistry} (the imperative `register` surface
 * contributions and framework self-registration use) with the dispatch entry
 * point called cross-class from
 * `BuildPipelineIntegration`
 * as the batch reaches each wired phase.
 *
 * Shared-tier (not per-language): a pass operates on the whole built batch, and
 * per-language work (integrity) fans out by language *inside* its pass. This
 * also keeps one priority space per phase across framework and adopter passes,
 * which is the point — `runPasses` orders the framework's integrity and
 * profiler-flush passes against adopter passes deterministically.
 */
export interface BuildPhasePassService extends BuildPhasePassRegistry {
   /**
    * Run every pass declaring `phase` as its state, in priority order,
    * sequentially — each pass is awaited before the next begins. The cancel
    * token is checked before each pass so a preempted build stops cleanly.
    * No-ops when no pass targets the phase. Called by
    * `BuildPipelineIntegration` from an `onBuildPhase` listener.
    */
   runPasses(documents: readonly LangiumDocument[], phase: DocumentState, cancelToken: CancellationToken): Promise<void>;
}

/** Construction options for {@link DefaultBuildPhasePassService}. */
export type BuildPhasePassServiceOptions = LogNameOptions;

/**
 * Default {@link BuildPhasePassService}. Generic registry for batch-level
 * build-phase work, the `onBuildPhase` sibling of
 * `DefaultAstExtensionService`
 * (which is per-node, `onDocumentPhase`). This class owns the registry +
 * priority-ordered dispatch; the listener lifecycle lives in
 * `BuildPipelineIntegration`,
 * which calls {@link runPasses} from its `onBuildPhase` listeners.
 *
 * **Performance:** {@link runPasses} shares the bucket-by-state cache pattern
 * with the AST-extension service — the per-state pass list is rebuilt lazily
 * only after a register / unregister, so steady-state dispatch allocates
 * nothing and early-outs when no pass targets the phase.
 *
 * **Profiling:** mirrors the AST-extension / integrity idiom — a debug-gated
 * `ProfileSession` scopes each pass by its
 * `id`, so `report('debug')` emits one self-time line per pass. At the default
 * `info` level no session is allocated.
 */
export class DefaultBuildPhasePassService implements BuildPhasePassService {
   protected readonly passes = new Registry<BuildPhasePass>();
   /** Per-state bucket of passes targeting each state, rebuilt lazily on the first run after a registry mutation. */
   protected stateBuckets = new Map<DocumentState, readonly BuildPhasePass[]>();
   protected stateBucketsFor: readonly BuildPhasePass[] | undefined;

   protected readonly tracer: Tracer;

   constructor(services: ServerSharedServices, options: BuildPhasePassServiceOptions = {}) {
      this.tracer = services.Tracer.for(options.logName ?? 'BuildPhasePass').trace('instantiated');

      // Read the shared `buildPhasePasses` contribution group and let each
      // contribution register one or many passes through this service. The `??`
      // fallback tolerates incomplete test stubs; production wiring provides the
      // slot via `createServerSharedModule` + adopter modules.
      const contributions = services.buildPhasePasses ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerBuildPhasePasses(this);
      }
   }

   register(pass: BuildPhasePass): Disposable {
      return this.passes.register(pass);
   }

   async runPasses(documents: readonly LangiumDocument[], phase: DocumentState, cancelToken: CancellationToken): Promise<void> {
      const bucket = this.getStateBucket(phase);
      if (bucket.length === 0) {
         return;
      }
      // Per-pass self-time profiling is opt-in: only open a session when the
      // debug threshold is active, so the production path allocates nothing and
      // the dispatch loop stays a single const-branch off `session`.
      const session = Logger.isLevelEnabled('debug') ? this.tracer.profile(`build-phase-pass ${DocumentState[phase]}`) : undefined;
      for (const pass of bucket) {
         if (cancelToken.isCancellationRequested) {
            break;
         }
         // Scope per pass id so the session aggregates self-time by pass across
         // the phase; off the profiling path call directly. `scope` awaits an
         // async `run`, so timing covers the full settle.
         if (session) {
            await session.scope(pass.id, () => pass.run(documents, cancelToken));
         } else {
            await pass.run(documents, cancelToken);
         }
      }
      // One line per pass (count + self-% + self-ms), sorted — only when profiling.
      session?.report('debug');
   }

   /**
    * Bucket-by-state view of {@link passes}, rebuilt lazily when the registry's
    * cached `all()` reference changes. Each bucket preserves the registry's
    * priority order (`Registry.all()` is already priority-sorted).
    */
   protected getStateBucket(phase: DocumentState): readonly BuildPhasePass[] {
      const current = this.passes.all();
      if (this.stateBucketsFor !== current) {
         const next = new Map<DocumentState, BuildPhasePass[]>();
         for (const pass of current) {
            let bucket = next.get(pass.state);
            if (!bucket) {
               bucket = [];
               next.set(pass.state, bucket);
            }
            bucket.push(pass);
         }
         this.stateBuckets = next;
         this.stateBucketsFor = current;
      }
      return this.stateBuckets.get(phase) ?? EMPTY_STATE_BUCKET;
   }
}

/** Shared empty result so `getStateBucket` doesn't allocate per call on the cold path. */
const EMPTY_STATE_BUCKET: readonly BuildPhasePass[] = Object.freeze([]);
