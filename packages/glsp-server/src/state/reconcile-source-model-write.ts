/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ConflictResolver, type Logger, isConflictError } from '@hydranium/protocol';

/**
 * The I/O and policy a {@link reconcileSourceModelWrite} call needs. Deliberately
 * a plain record rather than a base class: the states that use it differ in what
 * "persist" and "project" mean but not at all in how a conflict is handled, and
 * pulling the orchestration out is what keeps that second half from being
 * written once per state.
 */
export interface SourceModelWriteHooks<TModel> {
   /**
    * Write `model` and capture the resulting state. Called with a `baseVersion`
    * on the first attempt (opting into the `ConflictError` gate) and without one
    * on the merged / forced retries, where the point is to land the write.
    */
   persist(model: TModel, baseVersion?: number): Promise<void>;
   /** Current server-side projection, or `undefined` when unavailable. */
   refetch(): Promise<TModel | undefined>;
   /** Last in-sync projection the user's intent is measured against. */
   readonly baseline: TModel | undefined;
   readonly conflictResolver: ConflictResolver;
   readonly logger: Logger;
   /** Invoked when the edit is dropped, so the caller can resync its own state. */
   onConflictDropped(): void;
}

/**
 * Persist `model`, and on a `ConflictError` reconcile the user's intent against
 * the current server state via the injected policy and act on the outcome.
 *
 * One declarative policy shared by forward-write, undo and redo: force =
 * last-writer-wins, reconciling = field-level merge. A non-conflict error is
 * re-thrown untouched — this function only knows how to handle the specific
 * failure of "the based-on version was superseded".
 */
export async function reconcileSourceModelWrite<TModel extends object>(
   model: TModel,
   version: number | undefined,
   hooks: SourceModelWriteHooks<TModel>
): Promise<void> {
   try {
      await hooks.persist(model, version);
   } catch (err) {
      if (!isConflictError(err)) {
         throw err;
      }
      const outcome = await hooks.conflictResolver.resolve(hooks.baseline ?? model, model, () => hooks.refetch());
      switch (outcome.status) {
         case 'merged':
            await hooks.persist(outcome.merged);
            return;
         case 'no-op':
            hooks.logger.debug(`updateSourceModel no-op (v${err.expected} → v${err.actual}); already in sync`);
            return;
         case 'conflict':
            hooks.logger.warn(
               `updateSourceModel conflict (v${err.expected} → v${err.actual}); dropping the diagram edit — ` +
                  'a foreign writer changed the same field'
            );
            hooks.onConflictDropped();
            return;
         case 'unavailable':
            hooks.logger.warn(`updateSourceModel refetch unavailable (v${err.expected} → v${err.actual}); forcing without version`);
            await hooks.persist(model);
            return;
      }
   }
}
