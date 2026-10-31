/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ConflictError, isConflictError } from './errors';
import { type BaseVersion, type ModelVersion } from './model-service/base-version';
import { type ConflictResolver } from './patch-merge';

const DEFAULT_MAX_WRITES = 3;

/** A model and the version of the text it was read from, which a write based on it names. */
export interface VersionedModel<TModel> {
   readonly model: TModel;
   readonly baseVersion: ModelVersion;
}

/** The I/O and policy a {@link reconcileWrite} call needs. */
export interface ReconcileWriteHooks<TModel> {
   /**
    * Write `model`. Called with the caller's own `baseVersion` first, with the
    * refetch's on a merged write, and with `'any'` for a merge that refetched
    * nothing, where the resolver has already decided to win.
    */
   persist(model: TModel, baseVersion: BaseVersion): Promise<void>;
   /**
    * Current server-side model, or `undefined` when unavailable. Its version is
    * read in the tick its text is: a later one lets a merged write overwrite an
    * edit the merge never saw.
    */
   refetch(): Promise<VersionedModel<TModel> | undefined>;
   /** The last in-sync model the user's intent is measured against. */
   readonly base: TModel;
   /** Asked for each conflict while writes remain. Its refetch callback runs {@link refetch} only when called. */
   readonly conflictResolver: ConflictResolver;
   /** Writes, the first included, after which a conflict that would still merge is dropped. 3 when absent. */
   readonly maxWrites?: number;
   /**
    * Whether the write that raised `conflict` reached the server. One that
    * did not, refused by {@link persist} before it was sent, is not counted
    * against {@link maxWrites}, up to as many as it allows. Every write counts
    * when absent.
    */
   sent?(conflict: ConflictError): boolean;
   /** Runs when the refetch is unavailable; absent, the edit is left unwritten. */
   onUnavailable?(model: TModel, conflict: ConflictError): Promise<void>;
}

/**
 * What {@link reconcileWrite} did. Every status but `persisted` follows a
 * conflict, and carries the last one and the writes counted.
 */
export type ReconcileWriteOutcome =
   /** The first write landed. */
   | { readonly status: 'persisted' }
   | {
        /**
         * `merged`: a merged write landed. `already-applied`: the refetch
         * already held the edit, so nothing more was written. `unchanged`: the
         * edit was empty, so the caller is behind the server. `conflict`: the
         * resolver found a same-path collision. `dropped`: the writes ran out
         * with a merge left to write.
         * `unavailable`: the refetch produced nothing and
         * {@link ReconcileWriteHooks.onUnavailable} ran.
         */
        readonly status: 'merged' | 'already-applied' | 'unchanged' | 'conflict' | 'dropped' | 'unavailable';
        /** The last conflict a write raised, which on `merged` is the one before the write that landed. */
        readonly conflict: ConflictError;
        /**
         * Writes counted against {@link ReconcileWriteHooks.maxWrites}, the
         * first included. A write refused before it was sent is not counted,
         * up to as many as the cap, so 0 when every write was refused that
         * way. `dropped` is reported once they reach the cap.
         */
        readonly writes: number;
     };

/**
 * Persist `model`, and on a `ConflictError` reconcile the user's `base → model`
 * intent onto the refetched server model and write the merge, gated on the
 * refetch's version, again on each conflict up to `maxWrites` writes. The
 * conflict of the last write is resolved too, and only one that would merge
 * is dropped. A non-conflict error is re-thrown.
 */
export async function reconcileWrite<TModel extends object>(
   model: TModel,
   baseVersion: BaseVersion,
   hooks: ReconcileWriteHooks<TModel>
): Promise<ReconcileWriteOutcome> {
   let candidate = model;
   let candidateBaseVersion = baseVersion;
   let previous: ConflictError | undefined;
   const maxWrites = hooks.maxWrites ?? DEFAULT_MAX_WRITES;
   let writes = 0;
   let unsent = 0;
   for (;;) {
      const conflict = await persistOrConflict(hooks, candidate, candidateBaseVersion);
      if (conflict && unsent < maxWrites && hooks.sent?.(conflict) === false) {
         unsent++;
      } else {
         writes++;
      }
      if (!conflict) {
         return previous ? { status: 'merged', conflict: previous, writes } : { status: 'persisted' };
      }
      previous = conflict;
      // Asked after the last write too, so only a merge it may not write is dropped.
      let refetched: VersionedModel<TModel> | undefined;
      const outcome = await hooks.conflictResolver.resolve(hooks.base, model, async () => {
         refetched = await hooks.refetch();
         return refetched?.model;
      });
      switch (outcome.status) {
         case 'merged':
            if (writes >= maxWrites) {
               return { status: 'dropped', conflict, writes };
            }
            candidate = outcome.merged;
            candidateBaseVersion = refetched?.baseVersion ?? 'any';
            continue;
         case 'already-applied':
            return { status: 'already-applied', conflict, writes };
         case 'no-op':
            return { status: 'unchanged', conflict, writes };
         case 'conflict':
            return { status: 'conflict', conflict, writes };
         case 'unavailable':
            await hooks.onUnavailable?.(model, conflict);
            return { status: 'unavailable', conflict, writes };
      }
   }
}

/** The `ConflictError` the write raised, or `undefined` when it landed. */
async function persistOrConflict<TModel>(
   hooks: ReconcileWriteHooks<TModel>,
   model: TModel,
   baseVersion: BaseVersion
): Promise<ConflictError | undefined> {
   try {
      await hooks.persist(model, baseVersion);
      return undefined;
   } catch (err: unknown) {
      if (!isConflictError(err)) {
         throw err;
      }
      return err;
   }
}
