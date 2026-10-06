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
import { type BaseVersion, type TransferElement, type VersionedModel } from '@hydranium/protocol';
import { type OperationTransition } from '../command/hydranium-glsp-operation-command.js';
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
 * - {@link base} — the last in-sync projection, taken on every capture of
 *   the built root. A forward-write conflict reconciles the user's
 *   intent (base → ours) against the server's current root (theirs).
 * - {@link updateSourceModel} — the concrete reconcile template: persist,
 *   and on a `ConflictError` consult the injected `conflictResolver` and act
 *   on the merged / no-op / conflict / unavailable outcome.
 * - {@link persist} / {@link refetch} — the only I/O seams. Defaults route
 *   through the diagram session's `update` and `ModelService.validated`;
 *   adopters whose document round-trip differs override these without
 *   touching the orchestration.
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
    * The projection a forward-write conflict reconciles the user's intent
    * from, taken from the built root on every capture.
    */
   protected base!: TSourceModel;

   /**
    * Persisted-shape projection of the current source root, consumed by GLSP's
    * {@link JsonModelState} read side and recorded for field-level undo / redo.
    * Produced by the framework `TransferEncoder` in `'grammar'` mode
    * (cross-references → `$refText`, Langium internals + computed / synthetic
    * properties excluded), so the diff reflects only authored state.
    * Synchronous — the encoder walks the in-memory AST without serialising.
    */
   get sourceModel(): TSourceModel {
      return this.projectRoot(this.sourceRoot);
   }

   /**
    * The source model of `root`. The single projection seam: the source
    * model, the refetch and {@link normalizeTransition} all project through it.
    */
   protected projectRoot(root: AstNode): TSourceModel {
      return this.sharedServices.model.TransferEncoder.toTransfer(root, 'grammar') as unknown as TSourceModel;
   }

   /** Both ends serialized for the source document and parsed back, unless they are equal. */
   override async normalizeTransition(transition: OperationTransition<TSourceModel>): Promise<OperationTransition<TSourceModel>> {
      if (JSON.stringify(transition.from) === JSON.stringify(transition.to)) {
         return transition;
      }
      return {
         from: this.projectRoot(await this.roundTrip(this._sourceUri, transition.from)),
         to: this.projectRoot(await this.roundTrip(this._sourceUri, transition.to))
      };
   }

   protected override captureSourceRoot(uri: string, root: TRoot): void {
      super.captureSourceRoot(uri, root);
      this.base = this.sourceModel;
   }

   /**
    * Persist `model` back to the document store, then capture the resulting
    * AST root. On a `ConflictError` (the base version was superseded),
    * reconcile the user's intent against the server's current root via the bound
    * `conflictResolver` and act on the outcome — one declarative policy
    * (force = last-writer-wins, reconciling = field-level merge) shared with
    * undo / redo.
    */
   async updateSourceModel(model: TSourceModel, baseVersion: BaseVersion = this.baseVersion): Promise<void> {
      // Orchestration lives in `reconcileSourceModelWrite` so the multi-document
      // state gets the identical conflict handling; this method supplies only
      // the single-document meaning of persist / project.
      return reconcileSourceModelWrite<TSourceModel>(model, baseVersion, {
         persist: async (candidate, candidateBaseVersion) => {
            const { root } = await this.persist(candidate, candidateBaseVersion);
            this.captureWrittenRoot(root);
         },
         refetch: () => this.refetch(),
         base: this.base,
         conflictResolver: this.conflictResolver,
         logger: this.logger,
         onConflictDropped: () => this.writeDropped(),
         maxWrites: this.maxSourceModelWrites
      });
   }

   /**
    * Persist hook — the only write-side I/O. Default routes the structured
    * model through the diagram session's `update` (serialize → reparse),
    * opting into the `ConflictError` gate unless `baseVersion` is `'any'`,
    * and throws without a session. Adopters whose document
    * round-trip differs override this, and {@link normalizeTransition}
    * alongside so undo compares what this writes; the orchestration in
    * {@link updateSourceModel} is unchanged.
    */
   protected async persist(model: TSourceModel, baseVersion: BaseVersion): Promise<{ root: TRoot }> {
      const document = await this.requireModelSession().update({ uri: this._sourceUri, model, baseVersion });
      return document as unknown as { root: TRoot };
   }

   /**
    * Refetch hook — the stored text parsed afresh, as a persisted-shape
    * projection with the version of that text (or `undefined` when
    * unavailable): theirs, which the `conflictResolver` replays the user's
    * intent onto. Default uses {@link AbstractHydraniumGlspState.readCurrentRoot}
    * + the framework encoder's `'grammar'` mode; adopters override alongside
    * {@link persist}.
    */
   protected async refetch(): Promise<VersionedModel<TSourceModel> | undefined> {
      const theirs = await this.readCurrentRoot(this._sourceUri);
      return (
         theirs && {
            model: this.projectRoot(theirs.root),
            baseVersion: theirs.version
         }
      );
   }
}
