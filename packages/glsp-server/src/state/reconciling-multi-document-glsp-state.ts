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
import { type ClientSession, type ClientSessionWriteArgs } from '@hydranium/core';
import { asModelVersion, type BaseVersion, type ModelVersion, type TransferElement, type VersionedModel } from '@hydranium/protocol';
import { AbstractHydraniumGlspState } from './abstract-hydranium-glsp-state.js';
import { type OperationTransition, openOperationOf } from '../command/hydranium-glsp-operation-command.js';
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

/** A write set, with the version of each secondary's text it was projected from, keyed by URI. */
export interface VersionedMultiDocumentSourceModel<TPrimary extends TransferElement = TransferElement> extends VersionedModel<
   MultiDocumentSourceModel<TPrimary>
> {
   readonly secondaryVersions: Readonly<Record<string, ModelVersion>>;
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
 * **The write set is written all or none.** {@link persist} hands every
 * changed document to one `ClientSession.updateAll` on the diagram's session,
 * so a conflict on any document leaves every document of the set as it was,
 * and write order carries no meaning.
 *
 * **Every document of the set is gated.** The primary on the caller's
 * `baseVersion`, each secondary on {@link secondaryBaseVersion}, by default the version
 * it had when the source root was last read. A conflict on any of them is
 * reconciled against the whole write set, and the merged retry is gated on
 * the versions its refetch read. A write based on `'any'` — an undo or redo
 * applying a recorded patch — forces every document of the set.
 *
 * A secondary is written only while the diagram's session has it open. The
 * storage opens it as it joins the write set, and {@link openForWrite} opens it
 * again before each write; an adopter whose write set can name a document that
 * does not exist yet overrides {@link openForWrite} to create it through
 * {@link createSecondaryDocument}.
 */
@injectable()
export class ReconcilingMultiDocumentGlspState<TRoot extends AstNode, TPrimary extends TransferElement = TransferElement>
   extends AbstractHydraniumGlspState<TRoot, MultiDocumentSourceModel<TPrimary>>
   implements JsonModelState<MultiDocumentSourceModel<TPrimary>>
{
   /**
    * The projection across the whole write set that a forward-write conflict
    * reconciles the user's intent from, taken from the built roots on every
    * capture.
    */
   protected base!: MultiDocumentSourceModel<TPrimary>;

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
      return { primary: this.projectRoot(this.sourceRoot), secondaries };
   }

   protected override captureSourceRoot(uri: string, root: TRoot): void {
      super.captureSourceRoot(uri, root);
      this.trackWriteSet(uri);
      this.base = this.sourceModel;
   }

   /**
    * Each document whose ends differ, either end serialized for its URI and
    * parsed back; a document equal on both ends is left as it is, since it
    * stays out of the transition's patch anyway.
    */
   override async normalizeTransition(
      transition: OperationTransition<MultiDocumentSourceModel<TPrimary>>
   ): Promise<OperationTransition<MultiDocumentSourceModel<TPrimary>>> {
      const from = { primary: transition.from.primary, secondaries: { ...transition.from.secondaries } };
      const to = { primary: transition.to.primary, secondaries: { ...transition.to.secondaries } };
      if (JSON.stringify(from.primary) !== JSON.stringify(to.primary)) {
         from.primary = this.projectRoot<TPrimary>(await this.roundTrip(this._sourceUri, from.primary));
         to.primary = this.projectRoot<TPrimary>(await this.roundTrip(this._sourceUri, to.primary));
      }
      for (const uri of new Set([...Object.keys(from.secondaries), ...Object.keys(to.secondaries)])) {
         if (JSON.stringify(from.secondaries[uri]) === JSON.stringify(to.secondaries[uri])) {
            continue;
         }
         for (const end of [from, to]) {
            const secondary = end.secondaries[uri];
            if (secondary !== undefined) {
               end.secondaries[uri] = this.projectRoot(await this.roundTrip(uri, secondary));
            }
         }
      }
      return { from, to };
   }

   /**
    * Also takes a secondary first tracked during an operation into the base
    * and into the operation's projection from before its command, both from
    * the root its version was read from: a conflict on it reconciles from the
    * revision the operation's copy describes, and undoing the operation
    * restores it. A document that does not exist yet has no projection to
    * restore, so an undo leaves what the operation wrote into it.
    */
   override trackSecondaryDocument(uri: string): void {
      const added = uri !== this._sourceUri && !this.secondaryUris.includes(uri);
      super.trackSecondaryDocument(uri);
      const root = this.capturedRootOf(uri);
      if (root === undefined) {
         return;
      }
      const projection = this.projectRoot(root);
      if (this.base !== undefined && !(uri in this.base.secondaries)) {
         this.base = { ...this.base, secondaries: { ...this.base.secondaries, [uri]: projection } };
      }
      if (added) {
         openOperationOf(this)?.amendBefore(before =>
            isMultiDocumentModel(before) ? { ...before, secondaries: { ...before.secondaries, [uri]: projection } } : before
         );
      }
   }

   /**
    * During an operation, also drops the untracked documents from its
    * projection from before its command: they are not written, so the
    * operation's undo and redo leave them as they are.
    */
   override untrackSecondaryDocuments(): void {
      const untracked = this.secondaryUris;
      super.untrackSecondaryDocuments();
      openOperationOf(this)?.amendBefore(before =>
         isMultiDocumentModel(before)
            ? { ...before, secondaries: Object.fromEntries(Object.entries(before.secondaries).filter(([uri]) => !untracked.includes(uri))) }
            : before
      );
   }

   /**
    * Register the secondary documents that belong to the primary at `uri`, via
    * {@link AbstractHydraniumGlspState.trackSecondaryDocument}. Called on every
    * capture, after the primary is captured (so `sourceUri` is current) and
    * BEFORE the base is taken (so the base includes them).
    * Default: no secondaries.
    *
    * This hook exists because that ordering is a trap an adopter would otherwise
    * hit silently. Registering from an overridden `captureSourceRoot` *after*
    * `super.captureSourceRoot(...)` runs too late — the base has already been
    * captured without the secondaries, so the first conflict reconcile measures
    * the user's intent against a base missing half the write set and the
    * secondary edits look like foreign changes. Registering *before* the super
    * call is too early for a URI derived from the new primary. Overriding this
    * instead removes the choice.
    */
   protected trackWriteSet(_uri: string): void {
      // No-op by default; adopters with secondaries override.
   }

   /**
    * Persist the whole write set, then capture the resulting primary root. On a
    * `ConflictError` from any document of the set, reconcile via the injected
    * policy exactly as the single-document state does — the orchestration is
    * shared.
    */
   async updateSourceModel(model: MultiDocumentSourceModel<TPrimary>, baseVersion: BaseVersion = this.baseVersion): Promise<void> {
      let secondaryVersions: Readonly<Record<string, ModelVersion>> | undefined;
      return reconcileSourceModelWrite<MultiDocumentSourceModel<TPrimary>>(model, baseVersion, {
         persist: async (candidate, candidateBaseVersion) => {
            const { root } = await this.persist(candidate, candidateBaseVersion, secondaryVersions);
            this.captureWrittenRoot(root);
         },
         refetch: async () => {
            const refetched = await this.refetch();
            secondaryVersions = refetched?.secondaryVersions;
            return refetched;
         },
         base: this.base,
         conflictResolver: this.conflictResolver,
         logger: this.logger,
         onConflictDropped: () => this.writeDropped(),
         maxWrites: this.maxSourceModelWrites
      });
   }

   /**
    * Write hook — every document of `model` that changed, opened first through
    * {@link openForWrite}, in one `updateAll` on the diagram's session: the
    * primary gated on `baseVersion`, each secondary on its entry in
    * `secondaryVersions` (a refetch's) or else {@link secondaryBaseVersion}, or
    * every document on `'any'` when `baseVersion` is `'any'`. Resolves to
    * the primary's root, the one already captured when the primary did not
    * change. A write that bypasses `updateAll` gives up the all-or-none
    * guarantee the class describes. Throws without a session
    * ({@link requireModelSession}). An override that serializes otherwise than
    * `ModelService.modelToText` overrides {@link normalizeTransition} alongside.
    *
    * A write that fails closes every document {@link createSecondaryDocument}
    * created for it. Left open, a created document would stay in the
    * diagram's session with the text it was created with, and the diagram's
    * next save would write it to disk though no write landed in it.
    */
   protected async persist(
      model: MultiDocumentSourceModel<TPrimary>,
      baseVersion: BaseVersion,
      secondaryVersions?: Readonly<Record<string, ModelVersion>>
   ): Promise<{ root: TRoot }> {
      const primaryChanged = this.hasChanged(this.base.primary, model.primary);
      const changedSecondaries = Object.entries(model.secondaries).filter(([uri, secondary]) =>
         this.hasChanged(this.base.secondaries[uri], secondary)
      );
      if (!primaryChanged && changedSecondaries.length === 0) {
         return { root: this._sourceRoot };
      }
      const session = this.requireModelSession();
      this.createdForWrite.clear();
      try {
         if (primaryChanged) {
            await this.openForWrite(session, this._sourceUri);
         }
         for (const [uri] of changedSecondaries) {
            await this.openForWrite(session, uri);
         }
         // Based after the opens, so a secondary created there is gated on the version it was created at.
         const updates: ClientSessionWriteArgs<TransferElement>[] = primaryChanged
            ? [{ uri: this._sourceUri, model: model.primary, baseVersion }]
            : [];
         for (const [uri, secondary] of changedSecondaries) {
            updates.push({
               uri,
               model: secondary,
               baseVersion: baseVersion === 'any' ? 'any' : (secondaryVersions?.[uri] ?? this.secondaryBaseVersion(uri))
            });
         }
         const documents = await session.updateAll({ updates });
         return { root: primaryChanged ? (documents[0].root as unknown as TRoot) : this._sourceRoot };
      } catch (error: unknown) {
         for (const uri of this.createdForWrite) {
            try {
               await session.close(uri);
            } catch (closeError: unknown) {
               this.logger.warn(`Could not close ${uri}, created for a write that failed: ${String(closeError)}`);
            }
         }
         throw error;
      } finally {
         this.createdForWrite.clear();
      }
   }

   /** The documents {@link createSecondaryDocument} created for the {@link persist} under way. */
   protected readonly createdForWrite = new Set<string>();

   /**
    * Whether `candidate` differs from the base projection of the same
    * document, and therefore needs writing.
    *
    * **Skipping unchanged documents is correctness, not an optimisation.** A
    * write re-serializes from the AST, so writing a document that did not
    * change still rewrites its text in the serializer's own layout. Persisting
    * the whole write set unconditionally therefore means a pure layout drag
    * reflows the semantic file, a change the user never asked for and would
    * struggle to attribute. Comments survive that rewrite, but the
    * hand-formatting around them does not.
    *
    * Compared by serialised form. Both sides come from the same encoder walking
    * the same shape, so key order is stable and a string compare is sound here;
    * it is also cheap enough to run per document per write.
    */
   protected hasChanged(base: object | undefined, candidate: object): boolean {
      return base === undefined || JSON.stringify(base) !== JSON.stringify(candidate);
   }

   /**
    * Make sure the diagram's session has `uri` open before the write set is
    * written. Default: open it, a no-op for a document the session already
    * has open. Override to create a document the write set names before it
    * exists, through {@link createSecondaryDocument}: `updateAll` opens nothing.
    */
   protected openForWrite(session: ClientSession<AstNode>, uri: string): Promise<void> {
      return session.open(uri);
   }

   /**
    * Create the secondary `uri` holding `text` through `session.create`, and
    * base its write on the version the created document took. The version
    * recorded while it did not exist matches no write, so the write conflicts.
    */
   protected async createSecondaryDocument(session: ClientSession<AstNode>, uri: string, text: string): Promise<void> {
      const created = await session.create(uri, text);
      this.createdForWrite.add(uri);
      if (this._secondaryVersions.has(uri)) {
         this._secondaryVersions.set(uri, asModelVersion(created));
      }
   }

   /**
    * What a secondary write declares it was based on. Default: the version the
    * secondary had when the source root was last read
    * ({@link AbstractHydraniumGlspState.baseVersionOf}), so a foreign edit
    * to it since is reported as a conflict and reconciled rather than
    * overwritten; `'any'` for a secondary with no recorded version.
    * Return `'any'` to force secondary writes.
    */
   protected secondaryBaseVersion(uri: string): BaseVersion {
      return this.baseVersionOf(uri) ?? 'any';
   }

   /**
    * Refetch hook — the current projection across the write set, each document
    * read through {@link AbstractHydraniumGlspState.readCurrentRoot}, with the
    * versions read alongside: theirs, which the conflict resolver replays the
    * user's intent onto. Returns `undefined` when the PRIMARY cannot be read,
    * since a reconcile without it has nothing to merge into; an unreadable
    * secondary is omitted the same way {@link sourceModel} omits one.
    */
   protected async refetch(): Promise<VersionedMultiDocumentSourceModel<TPrimary> | undefined> {
      const theirs = await this.readCurrentRoot(this._sourceUri);
      if (!theirs) {
         return undefined;
      }
      const secondaries: Record<string, TransferElement> = {};
      const secondaryVersions: Record<string, ModelVersion> = {};
      for (const uri of this.secondaryUris) {
         const read = await this.readCurrentRoot(uri);
         if (read) {
            secondaries[uri] = this.projectRoot(read.root);
            secondaryVersions[uri] = read.version;
         }
      }
      return { model: { primary: this.projectRoot<TPrimary>(theirs.root), secondaries }, baseVersion: theirs.version, secondaryVersions };
   }

   /**
    * Project a currently-loaded document's root, or `undefined` when it is not
    * loaded: the open operation's copy of it when there is one, which is where
    * a handler's edit of it is, else the root its version was read from.
    */
   protected projectDocument(uri: string): TransferElement | undefined {
      const root =
         this.existingWorkingRootOf(uri) ??
         this.capturedRootOf(uri) ??
         this.sharedServices.model.ModelService.getDocument(uri)?.parseResult?.value;
      return root ? this.projectRoot(root) : undefined;
   }

   /** Grammar-mode transfer projection of one AST root. The single projection seam. */
   protected projectRoot<T extends TransferElement = TransferElement>(root: AstNode): T {
      return this.sharedServices.model.TransferEncoder.toTransfer(root, 'grammar') as unknown as T;
   }
}

function isMultiDocumentModel(value: object): value is MultiDocumentSourceModel {
   return 'secondaries' in value && typeof value.secondaries === 'object' && value.secondaries !== null;
}
