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
 * {@link reconcileWrite} for a diagram edit: logs the outcome, resyncs through
 * `onConflictDropped` when the edit is dropped, and forces the edit based on
 * `'any'` when the refetch is unavailable.
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
      maxWrites: hooks.maxWrites,
      onUnavailable: async (candidate, conflict) => {
         hooks.logger.warn(
            `updateSourceModel refetch unavailable (model v${conflict.baseVersion} / text v${conflict.actualVersion}); forcing without version`
         );
         await hooks.persist(candidate, 'any');
      }
   });
   if (outcome.status === 'persisted' || outcome.status === 'unavailable') {
      return;
   }
   const { conflict, writes } = outcome;
   const versions = `model v${conflict.baseVersion} / text v${conflict.actualVersion}`;
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
