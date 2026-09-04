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
 * GLSP {@link JsonRecordingCommand} base shared by all hydranium adopters.
 * Adds two things on top of GLSP's class:
 *
 *  1. A **time-labelled execute wrapper** so log lines record how long a
 *     user-facing operation takes end-to-end — including the `postChange`
 *     source-model update that re-parses the document. Otherwise the diff +
 *     patch + persist work happens silently and is hard to attribute when
 *     something is slow.
 *  2. A typed `state` field that exposes `updateSourceModel` for the
 *     `postChange` bridge AND the framework `logger` for time-labelled
 *     logging. GLSP's base class only types `modelState: JsonModelState`,
 *     which lacks the framework's logger surface.
 *
 * **Optional undo/redo bridge hooks.** An adopter command can supply
 * `undoAction` / `redoAction` callbacks invoked alongside the patch apply, to
 * re-emit a side-effect the patch itself does not carry. Provided as optional
 * constructor args so adopters get that composition surface without
 * subclassing. Operation handlers that don't need bridge callbacks omit them.
 *
 * **postChange semantics.** GLSP's `JsonRecordingCommand.postChange` calls
 * `modelState.updateSourceModel(newModel)` with the model only. The
 * framework lift overrides `postChange` so it also threads the based-on
 * version captured at command start — letting the downstream
 * `ModelService.update` opt into the `ConflictError` gate. Undo / redo
 * postChange calls run with version `undefined` (no gating): the user
 * authored against the recorded patch, not against a specific server
 * version, so re-applying it should succeed regardless of intervening
 * edits. The recorded patch itself encodes the semantic intent.
 */
export class HydraniumGlspRecordingCommand<TSourceModel extends AnyObject> extends JsonRecordingCommand<TSourceModel> {
   declare protected modelState: HydraniumGlspRecordingState<TSourceModel>;

   /**
    * Based-on version captured at {@link execute} start; threaded into
    * {@link postChange} so {@link AbstractHydraniumGlspState.updateSourceModel}
    * sees the version the user authored against. Cleared after `execute`
    * returns so undo / redo paths fall through to `updateSourceModel`
    * without a version (no gating).
    */
   protected activeVersion?: number;

   /**
    * Source-model snapshots captured at {@link execute} — the state the
    * command left ({@link afterSnapshot}) and the state it started from
    * ({@link beforeSnapshot}). {@link undo} / {@link redo} reconcile the
    * recorded transition against the *current* source model via the state's
    * {@link AbstractHydraniumGlspState.conflictResolver}, so under the default
    * reconciling policy a concurrent edit to another field survives and a
    * same-field collision is dropped rather than clobbered.
    */
   protected beforeSnapshot?: TSourceModel;
   protected afterSnapshot?: TSourceModel;

   constructor(
      modelState: HydraniumGlspRecordingState<TSourceModel>,
      /** Human-readable label for the operation; appears in the timing-pair log line. */
      protected readonly label: string,
      doExecute: () => MaybePromise<void>,
      /** Optional bridge invoked alongside undo patch application; for adopters
       *  that need to re-emit a side-effect the patch does not carry. */
      protected readonly undoAction?: () => MaybePromise<void>,
      /** Optional bridge invoked alongside redo patch application. */
      protected readonly redoAction?: () => MaybePromise<void>
   ) {
      super(modelState, doExecute);
   }

   /**
    * Time-label the full execute path: pre-state snapshot + `doExecute` +
    * post-state snapshot + patch-derive + `postChange` (which writes back
    * via {@link AbstractHydraniumGlspState.updateSourceModel}). The label combines
    * the operation name with the source-uri-stamped logger.
    *
    * Captures {@link AbstractHydraniumGlspState.version} at start so {@link postChange}
    * can thread the based-on version into `updateSourceModel`. The capture
    * is `try`/`finally`-scoped so undo / redo paths invoked later do not
    * see a stale captured version.
    */
   override async execute(): Promise<void> {
      const logger = this.modelState.logger.for('HydraniumGlspRecordingCommand');
      this.activeVersion = this.modelState.version;
      logger.debug(`Executing '${this.label}' (based-on doc.version=v${this.activeVersion})`);
      this.beforeSnapshot = this.deepClone(await this.getJsonObject());
      try {
         await this.modelState.tracer.for('HydraniumGlspRecordingCommand').time(`Execute command '${this.label}'`, () => super.execute());
      } finally {
         this.activeVersion = undefined;
      }
      this.afterSnapshot = this.deepClone(await this.getJsonObject());
   }

   /**
    * Override of GLSP's {@link JsonRecordingCommand.postChange} so the
    * call to {@link AbstractHydraniumGlspState.updateSourceModel} threads the
    * captured based-on version alongside the new model.
    *
    * During {@link execute} the version is the snapshot captured at
    * command start; during {@link undo} / {@link redo} it is `undefined`
    * — replaying a recorded patch does not author against a specific
    * server version, so no gate applies.
    */
   protected override postChange(newModel: TSourceModel): MaybePromise<void> {
      return this.modelState.updateSourceModel(newModel, this.activeVersion);
   }

   /**
    * Reconcile the recorded `after → before` transition against the
    * *current* source model via the state's
    * {@link AbstractHydraniumGlspState.conflictResolver}, invoke the optional adopter
    * `undoAction`, and persist via `postChange`. Under the default reconciling
    * policy the revert is replayed guarded by `test` ops, so a concurrent edit
    * to another field is preserved (merged) and a same-field collision is
    * dropped rather than clobbered; a force policy clobbers (last-writer-wins).
    * On anything but a clean merge the undo is a logged no-op — the side-effect
    * bridge and `postChange` only run on a merged result, preserving a
    * "bridge before commit" order.
    */
   override async undo(): Promise<void> {
      if (!this.undoPatch || this.beforeSnapshot === undefined || this.afterSnapshot === undefined) {
         return;
      }
      const logger = this.modelState.logger.for('HydraniumGlspRecordingCommand');
      logger.debug(`Undoing '${this.label}' at doc.version=v${this.modelState.version}`);
      const outcome = await this.modelState.conflictResolver.resolve(this.afterSnapshot, this.beforeSnapshot, async () =>
         this.getJsonObject()
      );
      if (outcome.status !== 'merged') {
         logger.warn(`Undo '${this.label}' skipped (${outcome.status}); a foreign edit changed a shared field since the command ran`);
         return;
      }
      await this.undoAction?.();
      await this.postChange?.(outcome.merged);
   }

   /**
    * Reconcile the recorded `before → after` transition against the current
    * source model, invoke the optional adopter `redoAction`, and persist via
    * `postChange`. Same guarded merge / drop semantics as {@link undo}.
    */
   override async redo(): Promise<void> {
      if (!this.redoPatch || this.beforeSnapshot === undefined || this.afterSnapshot === undefined) {
         return;
      }
      const logger = this.modelState.logger.for('HydraniumGlspRecordingCommand');
      logger.debug(`Redoing '${this.label}' at doc.version=v${this.modelState.version}`);
      const outcome = await this.modelState.conflictResolver.resolve(this.beforeSnapshot, this.afterSnapshot, async () =>
         this.getJsonObject()
      );
      if (outcome.status !== 'merged') {
         logger.warn(`Redo '${this.label}' skipped (${outcome.status}); a foreign edit changed a shared field since the undo`);
         return;
      }
      await this.redoAction?.();
      await this.postChange?.(outcome.merged);
   }
}
