/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, Logger, MessageAction, ModelState, RedoAction, UndoAction, UndoRedoActionHandler } from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { type AstNode } from '@hydranium/langium';
import { type MessageDefinition, defineMessage, describeError, isConflictError } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { isDiagramEditDroppedError, logActionFailure } from './diagram-edit-dropped-error.js';
import { type UndoRedoDirection, takeUndoRedoTally } from './hydranium-glsp-operation-command.js';

/** An undo did nothing: another editor has since changed a field it would restore. */
export const DIAGRAM_UNDO_SKIPPED = defineMessage(
   'hydranium/glsp-server/diagram-undo-skipped',
   'Nothing was undone: another editor has since changed what this undo would restore.'
);

/** A redo did nothing: another editor has since changed a field it would reapply. */
export const DIAGRAM_REDO_SKIPPED = defineMessage(
   'hydranium/glsp-server/diagram-redo-skipped',
   'Nothing was redone: another editor has since changed what this redo would reapply.'
);

/**
 * Part of an undo did nothing: of the operations one undo step undoes, as a
 * compound executed outside an operation does, another editor has since
 * changed a field some would restore, and the rest were undone.
 */
export const DIAGRAM_UNDO_PARTLY_SKIPPED = defineMessage(
   'hydranium/glsp-server/diagram-undo-partly-skipped',
   'Part of this undo was not applied: another editor has since changed some of what it would restore.'
);

/** Part of a redo did nothing, as {@link DIAGRAM_UNDO_PARTLY_SKIPPED} describes for an undo. */
export const DIAGRAM_REDO_PARTLY_SKIPPED = defineMessage(
   'hydranium/glsp-server/diagram-redo-partly-skipped',
   'Part of this redo was not applied: another editor has since changed some of what it would reapply.'
);

/**
 * An undo failed because another editor changed a field it writes while it
 * ran. GLSP clears the undo history on every failed undo or redo, so the
 * message says so: the next undo otherwise does nothing, unexplained.
 */
export const DIAGRAM_UNDO_FAILED = defineMessage(
   'hydranium/glsp-server/diagram-undo-failed',
   'Could not undo: another editor changed the same element meanwhile. The undo and redo history of this diagram was cleared.'
);

/** A redo failed as {@link DIAGRAM_UNDO_FAILED} describes for an undo. */
export const DIAGRAM_REDO_FAILED = defineMessage(
   'hydranium/glsp-server/diagram-redo-failed',
   'Could not redo: another editor changed the same element meanwhile. The undo and redo history of this diagram was cleared.'
);

/**
 * An undo failed for a reason of its own, a side effect that threw, say, and
 * GLSP cleared the history as it does on every failed undo or redo. The
 * reason goes in the message's details; the log has it in full.
 */
export const DIAGRAM_UNDO_ERROR = defineMessage(
   'hydranium/glsp-server/diagram-undo-error',
   'Could not undo: an error occurred. The undo and redo history of this diagram was cleared.'
);

/** A redo failed as {@link DIAGRAM_UNDO_ERROR} describes for an undo. */
export const DIAGRAM_REDO_ERROR = defineMessage(
   'hydranium/glsp-server/diagram-redo-error',
   'Could not redo: an error occurred. The undo and redo history of this diagram was cleared.'
);

/**
 * GLSP's undo and redo handler inside the state's `runExclusive`. GLSP's
 * command stack moves its position before it undoes or redoes the entry, so
 * the boundary covers the whole action: taken around the undo or redo alone,
 * an undo arriving while an operation runs would move the position past an
 * entry it then cannot undo.
 *
 * An undo or redo a foreign edit skipped, whole or in part, tells the client,
 * which otherwise sees nothing happen. One that fails ends here, as a message saying the
 * history was cleared in place of GLSP's generic notice for a failed action:
 * a dropped or conflicting one says another editor changed the element, and
 * any but a dropped one, which its reconcile has logged, is logged here.
 */
@injectable()
export class HydraniumGlspUndoRedoActionHandler extends UndoRedoActionHandler {
   @inject(ModelState) protected readonly modelState!: AbstractHydraniumGlspState<AstNode, unknown>;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
   @inject(Logger) protected readonly logger!: Logger;

   override execute(action: Action): Promise<Action[]> {
      return this.modelState.runExclusive(() => super.execute(action));
   }

   protected override undo(): Promise<Action[]> {
      return this.undoOrRedo('undo');
   }

   protected override redo(): Promise<Action[]> {
      return this.undoOrRedo('redo');
   }

   /**
    * Lifted from `@eclipse-glsp/server` 2.7.0's `UndoRedoActionHandler.undo`
    * and `redo`, telling the client of a skip and ending a failure of the
    * command stack's undo or redo, which flushes the history on any failure.
    * A failed submit after it leaves the history whole and fails as upstream.
    * The accompanying test pins upstream's source.
    */
   protected async undoOrRedo(direction: UndoRedoDirection): Promise<Action[]> {
      const undo = direction === 'undo';
      if (!(undo ? this.commandStack.canUndo() : this.commandStack.canRedo())) {
         return [];
      }
      // A tally no handler read, as of an undo whose submit failed or that ran outside this handler, is not this one's.
      takeUndoRedoTally(this.modelState);
      try {
         await (undo ? this.commandStack.undo() : this.commandStack.redo());
      } catch (error: unknown) {
         return [this.failure(direction, error)];
      }
      const actions = await this.modelSubmissionHandler.submitModel(direction);
      const { skipped, applied } = takeUndoRedoTally(this.modelState);
      if (skipped === 0) {
         return actions;
      }
      const message =
         applied === 0
            ? undo
               ? DIAGRAM_UNDO_SKIPPED
               : DIAGRAM_REDO_SKIPPED
            : undo
              ? DIAGRAM_UNDO_PARTLY_SKIPPED
              : DIAGRAM_REDO_PARTLY_SKIPPED;
      return [MessageAction.create(this.render(message), { severity: 'WARNING' }), ...actions];
   }

   /**
    * The message for an undo or redo that failed, logging a failure its
    * reconcile has not. A conflict thrown rather than dropped, by a state that
    * does not reconcile or a reconcile that could not read the text, is the
    * same foreign edit as a dropped write and is told as one.
    */
   protected failure(direction: UndoRedoDirection, error: unknown): MessageAction {
      const undo = direction === 'undo';
      if (isDiagramEditDroppedError(error)) {
         return MessageAction.create(this.render(undo ? DIAGRAM_UNDO_FAILED : DIAGRAM_REDO_FAILED), { severity: 'ERROR' });
      }
      logActionFailure(this.logger, undo ? UndoAction.create() : RedoAction.create(), error);
      if (isConflictError(error)) {
         // The conflict's own message names the document, which the details carry.
         return MessageAction.create(this.render(undo ? DIAGRAM_UNDO_FAILED : DIAGRAM_REDO_FAILED), {
            severity: 'ERROR',
            details: describeError(error)
         });
      }
      return MessageAction.create(this.render(undo ? DIAGRAM_UNDO_ERROR : DIAGRAM_REDO_ERROR), {
         severity: 'ERROR',
         details: describeError(error)
      });
   }

   protected render(message: MessageDefinition<string>): string {
      return this.sharedServices.MessageRenderer.renderMessage(message);
   }
}
