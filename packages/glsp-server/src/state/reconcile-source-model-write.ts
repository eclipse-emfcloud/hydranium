/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type BaseVersion, type Logger, type ReconcileWriteHooks, reconcileWrite } from '@hydranium/protocol';

/** The I/O and policy a {@link reconcileSourceModelWrite} call needs. */
export interface SourceModelWriteHooks<TModel> extends Omit<ReconcileWriteHooks<TModel>, 'onUnavailable'> {
   readonly logger: Logger;
   /** Invoked when the edit is dropped, so the caller can resync its own state. */
   onConflictDropped(): void;
}

/**
 * {@link reconcileWrite} for a diagram edit: logs the outcome, and resyncs
 * through `onConflictDropped` when the edit is dropped.
 *
 * A conflict whose refetch is unavailable, the current text not readable to
 * reconcile against, throws the `ConflictError` the write raised: forcing the
 * edit would overwrite text the diagram never saw. An operation then rolls
 * back and an undo or redo fails, as for any write that throws.
 */
export async function reconcileSourceModelWrite<TModel extends object>(
   model: TModel,
   baseVersion: BaseVersion,
   hooks: SourceModelWriteHooks<TModel>
): Promise<void> {
   const outcome = await reconcileWrite(model, baseVersion, {
      persist: (candidate, candidateBaseVersion) => hooks.persist(candidate, candidateBaseVersion),
      refetch: () => hooks.refetch(),
      base: hooks.base,
      conflictResolver: hooks.conflictResolver,
      maxWrites: hooks.maxWrites
   });
   if (outcome.status === 'persisted') {
      return;
   }
   const { conflict, writes } = outcome;
   const versions = `model v${conflict.baseVersion} / text v${conflict.actualVersion}`;
   if (outcome.status === 'unavailable') {
      hooks.logger.warn(`updateSourceModel refetch unavailable (${versions}); the diagram edit fails rather than overwrite unread text`);
      throw conflict;
   }
   switch (outcome.status) {
      case 'merged':
         hooks.logger.debug(`updateSourceModel merged (${versions}); landed on write ${writes}`);
         return;
      case 'unchanged':
         hooks.logger.debug(`updateSourceModel no-op (${versions}); the diagram is behind, its update catches it up`);
         return;
      case 'conflict':
         hooks.logger.warn(`updateSourceModel conflict (${versions}); dropping the diagram edit — a foreign writer changed the same field`);
         hooks.onConflictDropped();
         return;
      case 'dropped':
         hooks.logger.warn(
            `updateSourceModel still conflicting after ${writes} ${writes === 1 ? 'write' : 'writes'} (${versions}); dropping the diagram edit`
         );
         hooks.onConflictDropped();
         return;
   }
}
