/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MessageRenderer } from '@hydranium/core';
import { type BaseVersion, defineMessage, type Logger, type ReconcileWriteHooks, reconcileWrite } from '@hydranium/protocol';
import { DiagramTextUnreadableError, DiagramWriteRanOutError } from '../command/diagram-edit-dropped-error.js';

/**
 * A diagram edit was not applied because its writes ran out: each one
 * conflicted, because another writer kept changing the document. Made again,
 * the edit may land.
 */
export const DIAGRAM_EDIT_RAN_OUT = defineMessage(
   'hydranium/glsp-server/diagram-edit-ran-out',
   'Your diagram change was not applied: the document kept changing while it was written. Try again.'
);

/**
 * A diagram edit was not applied because its write conflicted and the
 * document's current text could not be read to reconcile it against.
 */
export const DIAGRAM_EDIT_UNREADABLE = defineMessage(
   'hydranium/glsp-server/diagram-edit-unreadable',
   'Your diagram change was not applied: the document cannot be read right now.'
);

/** The I/O and policy a {@link reconcileSourceModelWrite} call needs. */
export interface SourceModelWriteHooks<TModel> extends Omit<ReconcileWriteHooks<TModel>, 'onUnavailable'> {
   readonly logger: Logger;
   /** Renders the message of the error a run-out or unreadable write throws, which the client is shown. */
   readonly messageRenderer: MessageRenderer;
   /** Invoked when the edit collided with a foreign edit of the same field and was dropped, so the caller can resync its own state. */
   onConflictDropped(): void;
   /** Invoked when the document already held the edit, so the caller can take its built root. */
   onAlreadyApplied(): void;
   /**
    * Throw `DocumentSyntaxError` when the stored text of a document `refetch`
    * read does not parse. Run after every refetch, so an override of it cannot
    * merge into a recovered model.
    */
   assertParses(): void;
}

/**
 * {@link reconcileWrite} for a diagram edit: logs the outcome it ends, and
 * resyncs through `onConflictDropped` when the edit collided with a foreign
 * edit of the same field, through `onAlreadyApplied` when the document already
 * held it.
 *
 * A write that cannot reconcile throws, with nothing written, so an operation
 * rolls back, and an undo or redo is refused with the command stack's place
 * kept. Writes that ran out, each one conflicting on a document another writer
 * kept changing, throw `DiagramWriteRanOutError`: the reconcile found no
 * collision, so dropping the edit as one would tell the wrong reason. A
 * conflict whose refetch is unavailable, the current text not readable to
 * reconcile against, throws `DiagramTextUnreadableError`: forcing
 * the edit would overwrite text the diagram never saw. Both carry the last
 * conflict, and both leave the log to whoever ends the failure.
 */
export async function reconcileSourceModelWrite<TModel extends object>(
   model: TModel,
   baseVersion: BaseVersion,
   hooks: SourceModelWriteHooks<TModel>
): Promise<void> {
   const outcome = await reconcileWrite(model, baseVersion, {
      persist: (candidate, candidateBaseVersion) => hooks.persist(candidate, candidateBaseVersion),
      refetch: async () => {
         const refetched = await hooks.refetch();
         if (refetched) {
            hooks.assertParses();
         }
         return refetched;
      },
      base: hooks.base,
      conflictResolver: hooks.conflictResolver,
      maxWrites: hooks.maxWrites
   });
   if (outcome.status === 'persisted') {
      return;
   }
   const { conflict, writes } = outcome;
   const versions = `model v${conflict.baseVersion} / text v${conflict.actualVersion}`;
   switch (outcome.status) {
      case 'merged':
         hooks.logger.debug(`updateSourceModel merged (${versions}); landed on write ${writes}`);
         return;
      case 'already-applied':
         hooks.logger.debug(`updateSourceModel already applied (${versions}); the document already holds the diagram edit`);
         hooks.onAlreadyApplied();
         return;
      case 'unchanged':
         hooks.logger.debug(`updateSourceModel no-op (${versions}); the diagram is behind, its update catches it up`);
         return;
      case 'conflict':
         hooks.logger.warn(`updateSourceModel conflict (${versions}); dropping the diagram edit — a foreign writer changed the same field`);
         hooks.onConflictDropped();
         return;
      case 'dropped':
         hooks.logger.debug(
            `updateSourceModel still conflicting after ${writes} ${writes === 1 ? 'write' : 'writes'} (${versions}); the diagram edit fails`
         );
         throw new DiagramWriteRanOutError(hooks.messageRenderer.renderMessage(DIAGRAM_EDIT_RAN_OUT), conflict);
      case 'unavailable':
         hooks.logger.debug(
            `updateSourceModel refetch unavailable (${versions}); the diagram edit fails rather than overwrite unread text`
         );
         throw new DiagramTextUnreadableError(hooks.messageRenderer.renderMessage(DIAGRAM_EDIT_UNREADABLE), conflict);
   }
}
