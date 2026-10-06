/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AnyObject, type JsonModelState, JsonRecordingCommand, type MaybePromise } from '@eclipse-glsp/server';
import { type AstNode } from '@hydranium/langium';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { HydraniumGlspOperationCommand, openOperationOf, runOperation } from './hydranium-glsp-operation-command.js';

/**
 * Source-model state shape consumed by {@link HydraniumGlspRecordingCommand}.
 * The intersection ties together GLSP's read-side
 * {@link JsonModelState.sourceModel} getter with the framework's typed
 * `logger` and `sourceUri` accessors (used for time-labelled logging) and
 * the lifted `updateSourceModel` abstract from
 * {@link AbstractHydraniumGlspState.updateSourceModel}. Adopter states satisfy both
 * naturally by implementing `JsonModelState<TSourceModel>` on
 * their framework-state subclass.
 */
export type HydraniumGlspRecordingState<TSourceModel extends AnyObject> = AbstractHydraniumGlspState<AstNode, TSourceModel> &
   JsonModelState<TSourceModel>;

/**
 * GLSP {@link JsonRecordingCommand} base shared by all hydranium adopters: a
 * handler mutates `sourceRoot` in the command's runnable, and the operation
 * the command executes in writes the result once when it ends.
 *
 * **Optional undo/redo bridge hooks.** An adopter command can supply
 * `undoAction` / `redoAction` callbacks, run when the operation is undone or
 * redone and when a failed operation rolls back, to re-emit a side effect the
 * model does not carry. During an undo or redo they run against throwaway
 * copies, and a recording command executed there throws.
 *
 * A command executed outside an operation opens one of its own through
 * `runExclusive`, so executing it from inside the boundary with no operation
 * open deadlocks. Its undo and redo then undo and redo that operation without
 * taking the boundary, which the caller holds, as the framework's undo handler
 * does; taking it there would deadlock under that handler.
 */
export class HydraniumGlspRecordingCommand<TSourceModel extends AnyObject> extends JsonRecordingCommand<TSourceModel> {
   declare protected modelState: HydraniumGlspRecordingState<TSourceModel>;

   /** The operation this command opened, when it executed outside one. */
   protected ownOperation?: HydraniumGlspOperationCommand<TSourceModel>;

   constructor(
      modelState: HydraniumGlspRecordingState<TSourceModel>,
      /** Human-readable label for the operation; appears in the timing-pair log line. */
      protected readonly label: string,
      doExecute: () => MaybePromise<void>,
      /** Optional bridge invoked when the command is undone; for adopters
       *  that need to re-emit a side-effect the model does not carry. */
      protected readonly undoAction?: () => MaybePromise<void>,
      /** Optional bridge invoked when the command is redone. */
      protected readonly redoAction?: () => MaybePromise<void>
   ) {
      super(modelState, doExecute);
   }

   override async execute(): Promise<void> {
      const open = openOperationOf(this.modelState);
      if (!open) {
         const operation = new HydraniumGlspOperationCommand<TSourceModel>(this.modelState);
         if ((await this.modelState.runExclusive(() => runOperation(operation, () => this))) === 'executed') {
            this.ownOperation = operation;
         }
         return;
      }
      open.assertNotDuringUndoRedo(this.label);
      const tracer = this.modelState.tracer.for('HydraniumGlspRecordingCommand');
      tracer.debug(`Executing '${this.label}' (base version v${this.modelState.version})`);
      await tracer.time(`Execute command '${this.label}'`, () => super.execute());
      open.recordExecuted({ undo: () => this.undoAction?.(), redo: () => this.redoAction?.() });
   }

   /** Writes nothing: the operation the command executes in writes once when it ends. */
   protected override postChange(_newModel: TSourceModel): void {
      // Written by the operation.
   }

   /**
    * Inside an open operation does nothing: the operation runs the bridge, once
    * for every recording command that executed.
    */
   override async undo(): Promise<void> {
      if (!openOperationOf(this.modelState)) {
         await this.ownOperation?.undo();
      }
   }

   /** Inside an open operation does nothing, as {@link undo}. */
   override async redo(): Promise<void> {
      if (!openOperationOf(this.modelState)) {
         await this.ownOperation?.redo();
      }
   }
}
