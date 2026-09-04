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
 * Source model spanning more than one document: the primary document's
 * projection plus one per registered secondary, keyed by URI.
 *
 * Keyed by URI rather than held as an array so a recorded undo / redo patch
 * still addresses the right document when the tracked set has changed since the
 * patch was recorded — an array would re-apply by index and silently write the
 * wrong file. The JSON-Pointer escaping that URI keys imply is the patch
 * library's job, not the adopter's.
 */
export interface MultiDocumentSourceModel<TPrimary extends TransferElement = TransferElement> {
   /** Projection of the primary (diagram) document — the one `sourceUri` names. */
   primary: TPrimary;
   /** Projection of each registered secondary document, keyed by its URI. */
   secondaries: Record<string, TransferElement>;
}

/**
 * Editable GLSP state for a diagram whose edits span SEVERAL Langium documents —
 * a diagram file plus the semantic file it references, say, where creating a node
 * on the canvas writes both.
 *
 * The single-document `ReconcilingTransferHydraniumGlspState` cannot express
 * that: its `sourceModel`, `persist` and `refetch` are all defined over
 * `sourceUri` alone, so an adopter needing a second document had to override all
 * three — i.e. the entire class. This subclass keeps the same three seams and the
 * same conflict handling (both share {@link reconcileSourceModelWrite}) but
 * defines them over the primary plus the secondary write set registered through
 * {@link AbstractHydraniumGlspState.trackSecondaryDocument}.
 *
 * **Writes are NOT atomic, deliberately, and the window is real.** Each document
 * goes through its own `ModelService.update`, so a failure after the first write
 * has landed leaves the set inconsistent on disk. There is no multi-document
 * transaction to lean on: `WorkspaceLock` serialises builds but does not roll
 * back, and the document store commits per URI. An adopter that cannot accept the
 * window should not span documents in one operation.
 *
 * **What makes the window tolerable is write ORDER, and the rule is
 * referenced-before-referencing** — not "secondaries first" as such. Write the
 * document whose content the others point AT before the documents that point at
 * it, so a partial write leaves an unreferenced element (inert, and the direction
 * an integrity rule can repair) rather than a reference to something that does
 * not exist (a linking error). {@link persist} implements that as
 * secondaries-then-primary, which is correct for the common shape where the
 * primary is the DIAGRAM and the semantics it references are secondaries: the
 * user opened the diagram, so it is also the document the conflict gate should
 * guard. **An adopter whose primary is the referenced document — a semantic file
 * as the diagram source, with layout in a secondary — has the ordering backwards
 * and must override {@link persist} to write the primary first.** Overriding it
 * is the supported route; the base order is a default for the common case, not an
 * invariant of the class.
 *
 * **The conflict gate covers the primary only.** Secondaries are written without
 * a based-on version, so a concurrent foreign edit to one is overwritten rather
 * than reconciled. Gating them too would need a per-document reconcile whose
 * outcomes can disagree (merge one, conflict another) with no way to un-write the
 * merged one — the atomicity problem again, one layer up. The captured versions
 * ARE available via {@link AbstractHydraniumGlspState.capturedVersionOf}, so an
 * adopter that wants a coarser check can compare before writing.
 */
@injectable()
export class ReconcilingMultiDocumentGlspState<TRoot extends AstNode, TPrimary extends TransferElement = TransferElement>
   extends AbstractHydraniumGlspState<TRoot, MultiDocumentSourceModel<TPrimary>>
   implements JsonModelState<MultiDocumentSourceModel<TPrimary>>
{
   /**
    * Last in-sync projection across the whole write set, captured on every
    * {@link setSourceRoot}. Same role as the single-document baseline: the state a
    * forward-write conflict reconciles the user's intent against.
    */
   protected baseline?: MultiDocumentSourceModel<TPrimary>;

   /**
    * Projection of the primary plus every registered secondary, in the framework
    * encoder's `'grammar'` mode (authored state only — cross-references as
    * `$refText`, computed / synthetic properties excluded), so `fast-json-patch`
    * diffs per field across all of them at once.
    *
    * A secondary that is not currently loaded is OMITTED rather than represented
    * as `undefined`: an absent key produces no patch operations for that
    * document, whereas an explicit `undefined` would diff as a removal and
    * persist as a deletion of content the state simply could not see.
    */
   get sourceModel(): MultiDocumentSourceModel<TPrimary> {
      const secondaries: Record<string, TransferElement> = {};
      for (const uri of this.secondaryUris) {
         const projection = this.projectDocument(uri);
         if (projection) {
            secondaries[uri] = projection;
         }
      }
      return { primary: this.projectRoot(this._sourceRoot), secondaries };
   }

   override setSourceRoot(uri: string, root: TRoot): void {
      super.setSourceRoot(uri, root);
      this.trackWriteSet(uri);
      this.baseline = this.sourceModel;
   }

   /**
    * Register the secondary documents that belong to the primary at `uri`, via
    * {@link AbstractHydraniumGlspState.trackSecondaryDocument}. Called on every
    * {@link setSourceRoot}, after the primary is captured (so `sourceUri` is
    * current) and BEFORE the baseline is taken (so the baseline includes them).
    * Default: no secondaries.
    *
    * This hook exists because that ordering is a trap an adopter would otherwise
    * hit silently. Registering from an overridden `setSourceRoot` *after*
    * `super.setSourceRoot(...)` runs too late — the baseline has already been
    * captured without the secondaries, so the first conflict reconcile measures
    * the user's intent against a baseline missing half the write set and the
    * secondary edits look like foreign changes. Registering *before* the super
    * call is too early for a URI derived from the new primary. Overriding this
    * instead removes the choice.
    */
   protected trackWriteSet(_uri: string): void {
      // No-op by default; adopters with secondaries override.
   }

   /**
    * Persist the whole write set, then capture the resulting primary root. On a
    * `ConflictError` from the primary, reconcile via the injected policy exactly
    * as the single-document state does — the orchestration is shared.
    */
   async updateSourceModel(model: MultiDocumentSourceModel<TPrimary>, version?: number): Promise<void> {
      return reconcileSourceModelWrite<MultiDocumentSourceModel<TPrimary>>(model, version, {
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
    * Write hook — secondaries first (ungated), primary last (gated on
    * `baseVersion`). The order is the failure-mode choice documented on the
    * class, not incidental: override this when the primary is the document the
    * others REFERENCE, since then this order writes the references first.
    */
   protected async persist(model: MultiDocumentSourceModel<TPrimary>, baseVersion?: number): Promise<{ root: TRoot }> {
      for (const [uri, secondary] of Object.entries(model.secondaries)) {
         if (this.hasChanged(this.baseline?.secondaries[uri], secondary)) {
            await this.persistSecondary(uri, secondary);
         }
      }
      if (!this.hasChanged(this.baseline?.primary, model.primary)) {
         // Nothing to write, so nothing to gate either — return the root already
         // captured rather than round-tripping the document for no reason.
         return { root: this._sourceRoot };
      }
      return this.persistPrimary(model.primary, baseVersion);
   }

   /**
    * Whether `candidate` differs from the baseline projection of the same
    * document, and therefore needs writing.
    *
    * **Skipping unchanged documents is correctness, not an optimisation.** A
    * write goes through `ModelService.update`, which re-serializes from the AST —
    * so writing a document that did not change still rewrites its text, and a
    * serializer is free to normalise formatting and cannot preserve comments.
    * Persisting the whole write set unconditionally therefore means a pure layout
    * drag reflows the semantic file and strips its comments, which is a data
    * loss the user never asked for and would struggle to attribute.
    *
    * Compared by serialised form. Both sides come from the same encoder walking
    * the same shape, so key order is stable and a string compare is sound here;
    * it is also cheap enough to run per document per write.
    */
   protected hasChanged(baseline: object | undefined, candidate: object): boolean {
      return baseline === undefined || JSON.stringify(baseline) !== JSON.stringify(candidate);
   }

   /** Write the primary document, opting into the conflict gate when `baseVersion` is given. */
   protected async persistPrimary(model: TPrimary, baseVersion?: number): Promise<{ root: TRoot }> {
      const document = await this.sharedServices.model.ModelService.update({
         uri: this._sourceUri,
         model,
         clientId: this.clientId,
         baseVersion
      });
      return document as unknown as { root: TRoot };
   }

   /**
    * Write one secondary document. Ungated by design (see the class doc); override
    * alongside {@link persistPrimary} when the round-trip differs per document
    * role — a layout file and a semantic file need not share a serializer.
    */
   protected async persistSecondary(uri: string, model: TransferElement): Promise<void> {
      await this.sharedServices.model.ModelService.update({ uri, model, clientId: this.clientId });
   }

   /**
    * Refetch hook — the current settled projection across the write set, used by
    * the conflict resolver to replay the user's intent against fresh state.
    * Returns `undefined` when the PRIMARY cannot be read, since a reconcile
    * without it has nothing to merge into; an unreadable secondary is omitted the
    * same way {@link sourceModel} omits one.
    */
   protected async refetch(): Promise<MultiDocumentSourceModel<TPrimary> | undefined> {
      const fresh = await this.sharedServices.model.ModelService.validated(this._sourceUri).catch(() => undefined);
      if (!fresh) {
         return undefined;
      }
      const secondaries: Record<string, TransferElement> = {};
      for (const uri of this.secondaryUris) {
         const settled = await this.sharedServices.model.ModelService.validated(uri).catch(() => undefined);
         if (settled) {
            secondaries[uri] = this.projectRoot(settled.root as unknown as AstNode);
         }
      }
      return { primary: this.projectRoot(fresh.root as unknown as AstNode) as TPrimary, secondaries };
   }

   /** Project a currently-loaded document's root, or `undefined` when it is not loaded. */
   protected projectDocument(uri: string): TransferElement | undefined {
      const root = this.sharedServices.model.ModelService.getDocument(uri)?.parseResult?.value;
      return root ? this.projectRoot(root) : undefined;
   }

   /** Grammar-mode transfer projection of one AST root. The single projection seam. */
   protected projectRoot<T extends TransferElement = TransferElement>(root: AstNode): T {
      return this.sharedServices.model.TransferEncoder.toTransfer(root, 'grammar') as unknown as T;
   }
}
