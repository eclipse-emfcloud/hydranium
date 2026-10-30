/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Command, CompoundCommand, DefaultCommandStack, ModelState } from '@eclipse-glsp/server';
import { type ServerSharedServices } from '@hydranium/core';
import { isDocumentSyntaxError } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { HydraniumGlspOperationCommand, isCommandArray } from './hydranium-glsp-operation-command.js';
import { HydraniumGlspRecordingCommand } from './hydranium-glsp-recording-command.js';

/**
 * GLSP's command stack with the diagram's dirty state read from the text store:
 * dirty while any document the diagram's client session has open differs from
 * its file, as the store last knew the file. Undo and redo are GLSP's, except
 * that a refusal which left nothing behind keeps the history. A command whose
 * every write was dropped is not pushed.
 *
 * GLSP's own answer counts the diagram's commands since its last save, so it
 * misses every change the diagram did not make: another client's unsaved edit
 * leaves it clean, and a save it did not make of a document other than the
 * diagram's own leaves it dirty. Every `SetDirtyStateAction` GLSP sends reads
 * this answer.
 */
@injectable()
export class HydraniumGlspCommandStack extends DefaultCommandStack {
   @inject(ModelState) protected readonly modelState!: ModelState;
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   override get isDirty(): boolean {
      const textDocuments = this.sharedServices.workspace.TextDocuments;
      const clientId = this.modelState.clientId;
      return textDocuments.openDocuments().some(open => open.clients.includes(clientId) && textDocuments.isDirty(open.uri));
   }

   /**
    * Lifted from `@eclipse-glsp/server`'s `DefaultCommandStack.execute`,
    * pushing no entry for a recording command executed outside an operation
    * whose write was dropped, or a `CompoundCommand` of only such commands at
    * any depth: its undo would do nothing, and the user's next undo would be
    * spent on it. A compound that also changed something is pushed, warning
    * that its undo step leaves out what was dropped. The accompanying test
    * pins upstream's source.
    */
   override async execute(command: Command): Promise<void> {
      try {
         await command.execute();
      } catch (error: unknown) {
         this.handleError(error);
      }
      const leaves = leavesOf(command);
      const dropped = leaves.filter(leaf => leaf instanceof HydraniumGlspRecordingCommand && leaf.dropped).length;
      if (dropped > 0 && dropped === leaves.length) {
         return;
      }
      if (dropped > 0) {
         this.logger.warn(
            `${dropped} of ${leaves.length} commands of a compound executed outside an operation had their write dropped, ` +
               'so its undo step leaves them out; execute them in one operation to write and undo them as one'
         );
      }
      // Clear the command list past the top (i.e. the old redo list)
      this.commands = this.commands.slice(0, this.top + 1);
      this.commands.push(command);
      ++this.top;
      // if the saveIndex points to the old redo list we can never reach a state again
      // where save is not necessary. => ensure that `isDirty` always returns true
      if (this.saveIndex >= this.top) {
         this.saveIndex = -2;
      }
   }

   /**
    * Lifted from `@eclipse-glsp/server`'s `DefaultCommandStack.undo`, keeping
    * the history and its place when {@link leftNothingBehind} says the failure
    * changed nothing, so the user can undo again once the text parses. The
    * accompanying test pins upstream's source.
    */
   override async undo(): Promise<void> {
      if (this.canUndo()) {
         const command = this.commands[this.top--];
         try {
            await command.undo();
         } catch (error: unknown) {
            if (this.leftNothingBehind(command, error)) {
               this.top++;
               throw error;
            }
            this.handleError(this.flushedFailure(error));
         }
      }
   }

   /** Lifted from `DefaultCommandStack.redo` as {@link undo} is. */
   override async redo(): Promise<void> {
      if (this.canRedo()) {
         const command = this.commands[++this.top];
         try {
            await command.redo();
         } catch (error: unknown) {
            if (this.leftNothingBehind(command, error)) {
               this.top--;
               throw error;
            }
            this.handleError(this.flushedFailure(error));
         }
      }
   }

   /**
    * Whether `command` failed with `error` without changing anything. An
    * operation's undo or redo lets a `DocumentSyntaxError` out only when it
    * collides before running a step, or when its own write was refused and it
    * reverted every step it ran. A `CompoundCommand` runs its other children
    * back on its own, and a failure there is not reported, so it never
    * qualifies.
    */
   protected leftNothingBehind(command: Command, error: unknown): boolean {
      return (
         isDocumentSyntaxError(error) &&
         (command instanceof HydraniumGlspOperationCommand || command instanceof HydraniumGlspRecordingCommand)
      );
   }

   /**
    * `error` as the stack flushes on it. A `DocumentSyntaxError` says nothing
    * changed, which is no longer known here, so it becomes the `cause` of a
    * plain error.
    */
   protected flushedFailure(error: unknown): unknown {
      return isDocumentSyntaxError(error)
         ? new Error('A command was refused for a syntax error after it may have changed the model', { cause: error })
         : error;
   }

   /**
    * Lifted from `@eclipse-glsp/server`'s `DefaultCommandStack.handleError`
    * without its `error` line: the failure is rethrown, and whoever ends it
    * logs it. The accompanying test pins upstream's source.
    */
   protected override handleError(error: unknown): never {
      this.flush();
      this.logger.debug('A command failed; the command stack was flushed');
      throw error;
   }
}

/**
 * The commands `command` executes: itself, or a `CompoundCommand`'s children
 * at any depth, read from GLSP's protected `CompoundCommand.commands`, as the
 * operation reads them.
 */
function leavesOf(command: Command): Command[] {
   const children: unknown = command instanceof CompoundCommand ? Reflect.get(command, 'commands') : undefined;
   return isCommandArray(children) ? children.flatMap(leavesOf) : [command];
}
