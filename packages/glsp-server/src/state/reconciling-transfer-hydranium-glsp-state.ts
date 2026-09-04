/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type JsonModelState } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import { type TransferElement } from '@hydranium/protocol';
import { AbstractHydraniumGlspState } from './abstract-hydranium-glsp-state.js';
import { reconcileSourceModelWrite } from './reconcile-source-model-write.js';

/**
 * Editable GLSP state for adopters whose source model is a **structured
 * transfer-model projection** round-tripped through the language
 * `ModelService`. Adds the forward-write
 * reconcile machinery on top of the slim {@link AbstractHydraniumGlspState} base:
 *
 * - {@link sourceModel} — the persisted-shape projection of the current
 *   source root, produced by the framework
 *   `TransferEncoder` in `'grammar'` mode
 *   (grammar-declared properties only; computed / synthetic excluded). The
 *   field-level shape is what lets `fast-json-patch` diff per field, so undo /
 *   redo and forward-write reconcile act per field instead of clobbering the
 *   whole document.
 * - {@link baseline} — the last in-sync projection, captured on every
 *   {@link setSourceRoot}. A forward-write conflict reconciles the user's
 *   intent (baseline → attempted) against the fresh server root.
 * - {@link updateSourceModel} — the concrete reconcile template: persist,
 *   and on a `ConflictError` consult the injected `conflictResolver` and act
 *   on the merged / no-op / conflict / unavailable outcome.
 * - {@link persist} / {@link refetch} — the only I/O seams. Defaults route
 *   through `ModelService.update` / `.validated` (reachable from the base via
 *   `sharedServices.model`); adopters whose document round-trip differs
 *   override these without touching the orchestration.
 *
 * Adopters whose source model is whole-document text (a bare `{ text }`
 * source model) or that are read-only do NOT extend this class — they extend
 * {@link AbstractHydraniumGlspState} directly and supply their own `updateSourceModel`
 * (or throw). The conflict-resolution *policy* (reconcile vs force) is still
 * the base's injected `conflictResolver`; this class owns the forward-write
 * *orchestration* that consults it.
 */
@injectable()
export class ReconcilingTransferHydraniumGlspState<TRoot extends AstNode, TSourceModel extends TransferElement>
   extends AbstractHydraniumGlspState<TRoot, TSourceModel>
   implements JsonModelState<TSourceModel>
{
   /**
    * Last in-sync source-model projection, captured on every
    * {@link setSourceRoot} (initial load + post-update). The baseline a
    * forward-write conflict reconciles against: it stays the pre-command
    * state because operation handlers mutate `_sourceRoot` in place during
    * `execute` while `setSourceRoot` only re-runs once the write commits.
    */
   protected baseline?: TSourceModel;

   /**
    * Persisted-shape projection of the current source root, consumed by GLSP's
    * {@link JsonModelState} read side and recorded for field-level undo / redo.
    * Produced by the framework `TransferEncoder` in `'grammar'` mode
    * (cross-references → `$refText`, Langium internals + computed / synthetic
    * properties excluded), so the diff reflects only authored state.
    * Synchronous — the encoder walks the in-memory AST without serialising.
    */
   get sourceModel(): TSourceModel {
      return this.sharedServices.model.TransferEncoder.toTransfer(this._sourceRoot, 'grammar') as unknown as TSourceModel;
   }

   override setSourceRoot(uri: string, root: TRoot): void {
      super.setSourceRoot(uri, root);
      this.baseline = this.sourceModel;
   }

   /**
    * Persist `model` back to the document store, then capture the resulting
    * AST root. On a `ConflictError` (the based-on version was superseded),
    * reconcile the user's intent against the fresh server root via the bound
    * `conflictResolver` and act on the outcome — one declarative policy
    * (force = last-writer-wins, reconciling = field-level merge) shared with
    * undo / redo.
    */
   async updateSourceModel(model: TSourceModel, version?: number): Promise<void> {
      // Orchestration lives in `reconcileSourceModelWrite` so the multi-document
      // state gets the identical conflict handling; this method supplies only
      // the single-document meaning of persist / project.
      return reconcileSourceModelWrite<TSourceModel>(model, version, {
         persist: async (candidate, baseVersion) => {
            const { root } = await this.persist(candidate, baseVersion);
            this.setSourceRoot(this._sourceUri, root);
         },
         refetch: () => this.refetch(),
         baseline: this.baseline,
         conflictResolver: this.conflictResolver,
         logger: this.logger,
         onConflictDropped: () => this.refreshSourceRoot()
      });
   }

   /**
    * Persist hook — the only write-side I/O. Default routes the structured
    * model through `ModelService.update` (serialize → reparse), opting into
    * the `ConflictError` gate when `version` is given. Adopters whose document
    * round-trip differs override this; the orchestration in
    * {@link updateSourceModel} is unchanged.
    */
   protected async persist(model: TSourceModel, baseVersion?: number): Promise<{ root: TRoot }> {
      const document = await this.sharedServices.model.ModelService.update({
         uri: this._sourceUri,
         model,
         clientId: this.clientId,
         baseVersion
      });
      return document as unknown as { root: TRoot };
   }

   /**
    * Refetch hook — reads the current settled server root as a persisted-shape
    * projection (or `undefined` when unavailable). The `conflictResolver`
    * replays the user's intent against this fresh state. Default uses
    * `ModelService.validated` + the framework encoder's `'grammar'` mode;
    * adopters override alongside {@link persist}.
    */
   protected async refetch(): Promise<TSourceModel | undefined> {
      const fresh = await this.sharedServices.model.ModelService.validated(this._sourceUri).catch(() => undefined);
      return fresh ? (this.sharedServices.model.TransferEncoder.toTransfer(fresh.root, 'grammar') as unknown as TSourceModel) : undefined;
   }
}
