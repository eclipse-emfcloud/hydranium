/********************************************************************************
 * Copyright (c) 2024-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   type DirtyStateChangeReason,
   type GModelRootSchema,
   type LayoutOperation,
   ModelState,
   ModelSubmissionHandler,
   SetDirtyStateAction,
   type SetModelAction
} from '@eclipse-glsp/server';
import { IntegrityService } from '@hydranium/core';
import { inject, injectable } from 'inversify';
import { type AstNode, type DocumentState } from '@hydranium/langium';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';

/**
 * GLSP {@link ModelSubmissionHandler} base shared by all hydranium adopters.
 * Wraps {@link submitModel} with an optional document-state ready-gate and
 * post-action observability logging; preserves the {@link createSetModeAction}
 * handshake log; exposes a {@link hasPendingInitialRequest} guard adopters
 * use to suppress external rebuild reactions while the initial-load
 * `RequestModelAction` is still in flight.
 *
 * **What stays adopter-side.** Translation of the source AST to a GModel is
 * owned by GLSP's existing `GModelFactory` interface, bound separately
 * per `DiagramModule`. The submission handler is strictly orchestration —
 * deliberately no `translateToGModel` hook here; adopters wire their per-
 * diagram-type `GModelFactory` subclass via `bindGModelFactory()`.
 *
 * **Hooks.**
 * - {@link readyEvent} — {@link DocumentState} the {@link submitModel} flow
 *   awaits via {@link AbstractHydraniumGlspState.ready} before delegating to
 *   `super.submitModel`. Default {@link IntegrityService.SettledState}
 *   (`IndexedReferences`) — the GModel-factory walk sees a fully linked AST
 *   with cross-document references resolved AND post-build integrity rules
 *   applied. Adopters that need a different phase (earlier `Linked` for
 *   simpler models, later `Validated` to consume diagnostics, or `undefined`
 *   to opt out entirely) override this field.
 * - {@link formatSourceRoot} — adopter-specific AST description used in
 *   the submit-log line. Default returns `root.$type`.
 *
 * Logs through {@link AbstractHydraniumGlspState.logger} (the state's
 * URI-tagged tracer), so it carries no log-label field of its own.
 */
@injectable()
export class HydraniumGlspSubmissionHandler<TRoot extends AstNode, TSourceModel = string> extends ModelSubmissionHandler {
   @inject(ModelState) declare protected modelState: AbstractHydraniumGlspState<TRoot, TSourceModel>;

   /**
    * Document-state gate awaited before {@link submitModel} delegates to
    * `super.submitModel`. Default {@link IntegrityService.SettledState} so the
    * GModel factory walks a fully-linked, integrity-settled AST out of the
    * box. Adopters override (including to `undefined` to opt out entirely)
    * when their submission flow doesn't need to wait.
    */
   protected readyEvent: DocumentState | undefined = IntegrityService.SettledState;

   /**
    * True when a `RequestModelAction` has been accepted but the
    * corresponding {@link SetModelAction} response has not yet been
    * dispatched. Adopter storage uses this to suppress the "external
    * submit" rebuild reaction during the initial-load handshake: that
    * rebuild reaction would call `submitModel('external')`, which rebuilds
    * the GModel and bumps its revision; once the revision changes, the
    * client's first `computedBounds` (still carrying the old revision) is
    * dropped and the initial `SetModelAction` never fires.
    */
   hasPendingInitialRequest(): boolean {
      return this.requestModelAction !== undefined;
   }

   override async submitModel(reason?: DirtyStateChangeReason, layout?: LayoutOperation): Promise<Action[]> {
      if (this.readyEvent !== undefined) {
         // Adopters with on-build integrity rules wait so the GModel-factory walk sees
         // a settled AST; otherwise the GModel could include elements the build pass is
         // about to rewrite or remove. ready() also refreshes the captured source root
         // via onReadyRefreshed.
         await this.modelState.ready(this.readyEvent);
      }
      const actions = await super.submitModel(reason, layout);
      this._lastSubmittedSignature = this.signatureOf(actions);
      this.logSubmit(reason, actions);
      return actions;
   }

   /**
    * Content signature of the last submission, whatever its reason.
    *
    * **Tracked across every reason because the CLIENT cannot tell them apart.**
    * An operation submit and a later external rebuild that produce the same
    * graph are the same delivery as far as the canvas is concerned, so a
    * comparison scoped to one reason reports "changed" for a model the client
    * already has. `undefined` until the first submit.
    */
   get lastSubmittedSignature(): string | undefined {
      return this._lastSubmittedSignature;
   }

   protected _lastSubmittedSignature?: string;

   /**
    * Serialise the model-bearing actions of a submission into a comparable
    * signature.
    *
    * `requestId` is fresh per action and `revision` is a monotonic `GModelRoot`
    * counter bumped on every rebuild, so neither reflects content.
    *
    * **`SetDirtyStateAction` is dropped whole rather than having its `reason`
    * stripped by key, and the distinction is load-bearing.** Measured: an
    * operation submit and the external rebuild echoing it are byte-identical
    * across the entire GModel and differ only in that action's `reason`, so
    * leaving it in defeats the comparison outright. Stripping the KEY instead
    * would reach further than intended — `reason` carries meaning on other
    * actions, `SetMarkersAction` among them — and would quietly weaken any
    * later comparison that includes one. Dropping the action also keeps
    * `isDirty` out, which is correct: dirty state is not part of "is this the
    * same model", and a genuine dirty-to-clean change must not be suppressed as
    * a duplicate model.
    */
   protected signatureOf(actions: Action[]): string {
      return JSON.stringify(
         actions.filter(action => !SetDirtyStateAction.is(action)),
         (key, value) => (key === 'requestId' || key === 'revision' ? undefined : value)
      );
   }

   /**
    * Logs the {@link SetModelAction} dispatch so the initial
    * `requestModel → setModel` handshake is observable in the server log
    * alongside `Submit model` and `ComputedBounds accepted`.
    */
   protected override createSetModeAction(newRoot: GModelRootSchema): SetModelAction {
      const action = super.createSetModeAction(newRoot);
      this.modelState.logger.info(
         `Dispatching SetModelAction (response to requestModel #${action.responseId || '?'}) — initial model handshake complete`
      );
      return action;
   }

   protected logSubmit(reason: DirtyStateChangeReason | undefined, actions: Action[]): void {
      const root = this.modelState.root;
      const gChildren = root?.children?.length ?? 0;
      const sourceRoot = this.modelState.sourceRoot;
      const kinds = actions.map(a => a.kind).join(',');
      this.modelState.logger.info(
         `Submit model [reason=${reason ?? 'initial'}, actions=[${kinds}], ` +
            `gmodel={type=${root?.type ?? 'none'}, children=${gChildren}}, ` +
            `ast={${this.formatSourceRoot(sourceRoot)}}]`
      );
   }

   /**
    * Hook for adopter-specific AST description in the submit-log line.
    * Default returns `root.$type` (or `'none'` when the source root is
    * undefined). Adopters with multi-shape source roots override to add
    * per-shape detail.
    */
   protected formatSourceRoot(root: TRoot | undefined): string {
      return root?.$type ?? 'none';
   }
}
