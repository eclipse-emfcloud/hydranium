/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { compare } from 'fast-json-patch';
import { type Disposable, Emitter, type Event } from 'vscode-jsonrpc';
import { type Clock, SystemClock, TIMED_OUT } from '../clock';
import { ConflictError, DocumentNotOpenError, SaveFailedError, STALE_BASE_VERSION_SAVE, STALE_BASE_VERSION_UPDATE } from '../errors';
import { isModelVersion, type ModelVersion, UNRECORDED_VERSION } from '../model-service/base-version';
import { type ConflictResolver, type ReconcileOutcome, ReconcilingConflictResolver } from '../patch-merge';
import { PendingWorkTracker } from '../pending-work-tracker';
import { type ReconcileWriteOutcome, reconcileWrite, type VersionedModel } from '../reconcile-write';
import type { TransferDiagnostic } from '../transfer-diagnostic';
import { type LoadedTransferDocument, type TextState, TransferDocument, type TransferSavedDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';
import { Deferred } from '../util';
import type { DataEvents } from './data-events';
import type { DataSession, DataSessionRestoreEvent } from './data-session';

/** What the write that carried an {@link WorkingCopy.edit} did. */
export type WorkingCopyEditOutcome =
   /** The write landed against an unchanged document. */
   | { readonly status: 'applied' }
   /** The write raced a foreign edit to other paths, and both landed. */
   | { readonly status: 'merged' }
   /**
    * The edit raced a foreign edit of the same path, or kept racing foreign
    * edits, and was dropped, or wrote a path an edit before it lost that way.
    * A server that normalizes the copy's own write, as a name it trims, also
    * yields it for an edit of that path made while the write was out. The
    * copy shows the server's value, unless the read after the last race
    * failed.
    */
   | { readonly status: 'conflict' }
   /** Nothing was written: the server already held the edit, or it changed nothing. */
   | { readonly status: 'unchanged' }
   /**
    * Nothing was written, because the copy was closed, its file deleted, a
    * restore could not open it again or its open's second read failed, before
    * a write carried the edit.
    */
   | { readonly status: 'unavailable' };

/**
 * One open of a {@link WorkingCopy}, from the answer to its first read until a
 * close, a deletion or a failure ends it. A request records its answer only
 * while the open it was sent under is still the copy's, so nothing of an
 * ended open reaches the next.
 */
export interface WorkingCopyOpen<TTransfer extends TransferElement> {
   /** The last document the server sent. */
   snapshot: TransferDocument<TTransfer>;
   /** The copy's restores heard when {@link snapshot} was taken. */
   snapshotRestores: number;
   /**
    * Whether {@link snapshot} was taken while a write was out, so it may hold
    * the edits {@link sending} applies again. A base made on it then is
    * unconfirmed, so its first write is reconciled, not sent.
    */
   snapshotUnderWrite?: boolean;
   /** Edits not yet written, in edit order, each until the write that carries it answers. */
   queued: { readonly change: (root: TTransfer) => TTransfer; readonly outcome: Deferred<WorkingCopyEditOutcome> }[];
   /**
    * The root the first queued edit was made on, the write in flight
    * included, and the snapshot version their write is gated on. A foreign
    * update that lands while they wait then conflicts and is reconciled,
    * instead of being written over, and the copy's own write does not.
    * `restores` is the copy's restores heard when that root was taken. A base
    * from before a restore conflicts on its first write. `unconfirmed` marks
    * a base whose write before a conflict dropped edits from. The root is then
    * the one that write was made on with only the edits it kept, so an edit
    * restating a dropped value conflicts, and its first write conflicts too.
    * It also marks a base made on a {@link snapshotUnderWrite}. `dropped`
    * makes any edit of a path a dropped edit wrote conflict, a revert to the
    * value before it included.
    */
   base?: VersionedModel<TTransfer> & {
      readonly restores: number;
      readonly unconfirmed?: boolean;
      /** The root the user saw before a conflict dropped edits, and the paths those edits wrote. */
      readonly dropped?: { readonly seen: TTransfer; readonly paths: readonly string[] };
   };
   /** Edits of the write in flight, in edit order. */
   sending: WorkingCopyOpen<TTransfer>['queued'];
   /** Whether a write loop runs. */
   writing: boolean;
   /** The server's dirty flag, as last sent. */
   serverDirty: boolean;
   /** Requests out whose answer replaces the snapshot. */
   snapshotRequests: number;
   /**
    * The newest document the server sent while a request is out, held until a
    * request answers with no write out, or for
    * {@link WorkingCopy.settleWritesMs} at most.
    */
   held?: TransferDocument<TTransfer>;
   /** Takes {@link held} once it has waited {@link WorkingCopy.settleWritesMs}. */
   holdTimer?: Disposable;
   /** The text version of the dirty flag last taken, so an answer built earlier does not undo a later save. */
   dirtyVersion?: number;
   /** Whether that flag came as a dirty event, which a document at its version does not undo. */
   dirtyFromEvent: boolean;
}

/** `root()`, or `undefined` when an edit's change throws on the way. */
function rootOrUndefined<TTransfer>(root: () => TTransfer | undefined): TTransfer | undefined {
   try {
      return root();
   } catch {
      return undefined;
   }
}

/**
 * For each edit of `batch`, whether it writes a path an edit dropped before
 * it wrote, replayed on the root the user saw, so a revert to the value
 * before the dropped edit counts. A restated dropped value conflicts on the
 * unconfirmed base already.
 */
function writesDropped<TTransfer extends TransferElement>(
   batch: readonly { readonly change: (root: TTransfer) => TTransfer }[],
   dropped: { readonly seen: TTransfer; readonly paths: readonly string[] } | undefined
): boolean[] {
   if (!dropped) {
      return batch.map(() => false);
   }
   const overlaps = (path: string): boolean =>
      dropped.paths.some(droppedPath => path === droppedPath || path.startsWith(`${droppedPath}/`) || droppedPath.startsWith(`${path}/`));
   let root: TTransfer | undefined = dropped.seen;
   return batch.map(edit => {
      const before = root;
      root = before === undefined ? undefined : rootOrUndefined(() => edit.change(before));
      return before !== undefined && root !== undefined && compare(before, root).some(operation => overlaps(operation.path));
   });
}

/**
 * `base` with the edits of `batch` its `outcomes` did not drop, or `base`
 * alone when one of those throws on it.
 */
function keptOf<TTransfer>(
   batch: readonly { readonly change: (root: TTransfer) => TTransfer }[],
   outcomes: readonly (WorkingCopyEditOutcome | Promise<never>)[],
   base: TTransfer
): TTransfer {
   return rootOrUndefined(() => batch.reduce((root, edit, index) => (isDropped(outcomes[index]) ? root : edit.change(root)), base)) ?? base;
}

/** Whether a batch's edit did not reach the server: a conflict dropped it, or its write failed. */
function isDropped(outcome: WorkingCopyEditOutcome | Promise<never>): boolean {
   return !('status' in outcome) || outcome.status === 'conflict';
}

/**
 * The client's working copy of one data-server document: the server's latest
 * snapshot of it, plus the edits the server has not confirmed yet.
 *
 * - **Follows the server.** Another client's update replaces the snapshot and
 *   fires {@link onDidChange}. This session's own echoes are skipped while a
 *   request is out, since the write's answer carries them. A document the
 *   server sends while a write, a save, a reread or the open's second read is
 *   out waits. The newest is taken when one of them answers and no write is
 *   out, or once the first of them has waited {@link settleWritesMs}. A write
 *   still out then has its edits applied to a document that may hold them
 *   already, so an edit that does not give the same root twice may show twice
 *   until its write answers. A batch made on that document has its first
 *   write reconciled, so the edit is not written twice.
 * - **Batches edits behind a write.** An edit goes out at once when no write
 *   is out. The edits made while one is out go out after it, as one write of
 *   the whole root, gated on the version of the snapshot the first of them
 *   was made on, or of the answer to the copy's write before when that landed
 *   unchanged. Each edit resolves to a {@link WorkingCopyEditOutcome}, its
 *   batch's unless the batch splits on a conflict.
 * - **Reconciles.** A write that meets a newer version goes through
 *   `reconcileWrite`: the edits are replayed onto the refetched root, and a
 *   same-path collision drops the edit that made it in favour of the
 *   server's value. The other edits of its batch are still written.
 * - **Counts its own edits as dirty.** {@link dirty} is the server's flag, or
 *   true while an edit is unanswered, so a host never shows clean text with
 *   an edit still on its way.
 *
 * Its session's own writes of the document are taken as echoes while a
 * request is out, so the copy is the only writer of the document on its
 * session. One heard with none out is taken, as a late write of a copy
 * before it may be.
 *
 * One URI per copy, for its whole life. Opening another document is a new
 * copy, so no queued edit can land on a document it was not made for. Open a
 * new copy of the same document on the same session only once the last one's
 * {@link close} has settled, since the copy does not check it. The session
 * holds one open per document, so a close sent later would end the new copy's
 * open too.
 *
 * An edit is a function of the root and runs again on every newer snapshot
 * until its write answers, so it must be pure. Running it once and keeping the
 * result would hide a foreign update behind the edit's stale copy of the root.
 * One that throws on a newer root makes {@link root} throw too, until its
 * write answers.
 */
export class WorkingCopy<TTransfer extends TransferElement> {
   protected readonly changeEmitter = new Emitter<void>();
   /** Fires whenever {@link root} or {@link diagnostics} may have changed. */
   readonly onDidChange: Event<void> = this.changeEmitter.event;
   protected readonly dirtyEmitter = new Emitter<void>();
   /** Fires whenever {@link dirty} changes. Apart from {@link onDidChange}, since a save changes no content. */
   readonly onDidChangeDirty: Event<void> = this.dirtyEmitter.event;

   /** Asked for each conflicting write, see {@link reconcile}. */
   protected readonly conflictResolver: ConflictResolver = new ReconcilingConflictResolver();
   /**
    * Writes of one reconcile, the first included, before a still-conflicting
    * one is dropped. A first write the copy refuses unsent, on a base from
    * before a restore or one a conflict dropped edits from, counts too. A
    * split batch reconciles twice, so one batch makes at most twice the cap
    * less one writes. Absent, `reconcileWrite`'s default applies.
    */
   protected readonly maxWrites?: number;
   /** How long {@link whenWritesSettled} waits before going on anyway. */
   protected readonly settleWritesMs: number = 30_000;
   /** The clock of {@link settleWritesMs}. */
   protected readonly clock: Clock = new SystemClock();

   /**
    * The open the copy follows. A close, a deletion or a failure ends it, and a
    * request sent under an earlier one neither counts nor answers.
    */
   protected current?: WorkingCopyOpen<TTransfer>;
   /** Restores heard that may have renumbered the versions, see {@link handleDocumentRestored}. */
   protected restores = 0;
   /** Every edit until its write answers, so a settle waits on rereads after a conflict too. */
   protected readonly editsInFlight = new PendingWorkTracker();
   /** {@link dirty} as last announced. */
   protected announcedDirty = false;
   /** Requests being settled, during which {@link onDidChangeDirty} waits, since their answer is not taken yet. */
   protected settling = 0;
   /** The open, under way or done, which a later call shares until a deletion or a failure clears it. */
   protected opening?: Promise<void>;
   /** The close, once called. The copy does not open again after it. */
   protected closing?: Promise<void>;
   /** The listeners on the session and its events, ended once {@link dispose} ran and the edits have answered. */
   protected readonly subscriptions: Disposable[];
   /** Set by {@link dispose}, after which nothing is announced. */
   protected disposed = false;
   /** Set once {@link close} stopped waiting for the open, which then ends when it answers. */
   protected openAbandoned = false;

   constructor(
      protected readonly session: DataSession<TTransfer>,
      protected readonly events: DataEvents<TTransfer>,
      /** The document followed, as the caller spells it, which the session keys its open by. */
      readonly uri: string
   ) {
      // A deletion carries no document, so it has a channel of its own.
      this.subscriptions = [
         events.onDidUpdateDocument(event => this.handleDocumentUpdated(event)),
         events.onDidDeleteDocument(event => this.handleDocumentDeleted(event)),
         events.onDidChangeDocumentDirty(event => {
            const open = this.current;
            if (open && event.uri === open.snapshot.uri) {
               this.takeDirty(open, event.text ?? { dirty: false }, true);
            }
         }),
         session.onDidRestoreDocument(event => this.handleDocumentRestored(event))
      ];
   }

   /** The last document the server sent, without the edits it has not confirmed. `undefined` before {@link open}. */
   get snapshot(): TransferDocument<TTransfer> | undefined {
      return this.current?.snapshot;
   }

   /** The version of {@link snapshot}. A write is gated on the version its batch was made on, see the class doc. */
   get version(): ModelVersion | undefined {
      return this.current?.snapshot.model?.version;
   }

   /** The server's root with every unconfirmed edit applied. `undefined` when no document is loaded. */
   get root(): TTransfer | undefined {
      const open = this.current;
      const root = open?.snapshot.model?.root;
      return root && [...open.sending, ...open.queued].reduce((edited, edit) => edit.change(edited), root);
   }

   /**
    * Diagnostics as of the last snapshot. A write answers once its document is
    * validated, so they hold for the copy's own edits without an update push.
    * After a reconnect the ones from before stay until the copy's reread
    * answers, or the next update when it fails.
    */
   get diagnostics(): readonly TransferDiagnostic[] {
      return this.current?.snapshot.model?.diagnostics ?? [];
   }

   /** Whether the server's text differs from the file, or an edit has not been confirmed. */
   get dirty(): boolean {
      const open = this.current;
      return !!open && (open.serverDirty || open.queued.length > 0 || open.sending.length > 0);
   }

   /** Whether an edit has not answered yet. Synchronous, for an unload guard. */
   get hasWritesInFlight(): boolean {
      return !this.editsInFlight.isIdle;
   }

   /**
    * Open and watch the document, then read it again with diagnostics. The
    * open settles before validation, so without the second read a document
    * that was never edited reports no problems. Fires a change once both reads
    * have answered and the open stands, and before that only for a document a
    * restore hands over meanwhile. Repeated calls share the first one, and a
    * failed open may be retried. Rejects once {@link close} was called, and
    * with a `DocumentNotOpenError` when the file is gone by the second read. A
    * failed second read rejects once the session is connected, so after a
    * dropped connection it waits for the reconnect, and resolves when the
    * restore took the document over.
    */
   async open(): Promise<void> {
      this.assertLive();
      if (this.closing) {
         throw new Error('WorkingCopy is closed');
      }
      const opening = (this.opening ??= this.load().catch((error: unknown) => {
         // A deletion may have ended this open and another one begun.
         if (this.opening === opening) {
            this.opening = undefined;
         }
         throw error;
      }));
      return opening;
   }

   /**
    * Queue `change` for the next write. The edit shows in {@link root} at once.
    * Resolves to the outcome of the write that carried it, and rejects when
    * that write fails for another reason than a conflict, as with a
    * `DocumentSyntaxError` while the document does not parse. Rejects with a
    * `DocumentNotOpenError` when the copy follows no document, and with what
    * `change` throws on {@link root}, queueing nothing. A change that throws
    * only on a later root rejects every edit of the write that carries it.
    */
   async edit(change: (root: TTransfer) => TTransfer): Promise<WorkingCopyEditOutcome> {
      this.assertLive();
      const open = this.requireOpen();
      const loaded = TransferDocument.assertLoaded(open.snapshot);
      // Run once here, so a change that throws fails only its own edit. One
      // before it that throws on this root fails its own write instead.
      const shown = rootOrUndefined(() => this.root);
      if (shown) {
         change(shown);
      }
      const edit: WorkingCopyOpen<TTransfer>['queued'][number] = { change, outcome: new Deferred<WorkingCopyEditOutcome>() };
      open.base ??= {
         // A sent edit that throws on this root is measured as none.
         model: rootOrUndefined(() => open.sending.reduce((root, sent) => sent.change(root), loaded.model.root)) ?? loaded.model.root,
         baseVersion: loaded.model.version,
         restores: open.snapshotRestores,
         unconfirmed: (open.snapshotUnderWrite && open.sending.length > 0) || undefined
      };
      open.queued.push(edit);
      this.editsInFlight.track(edit.outcome.promise).catch(() => undefined);
      this.announceDirty();
      this.changeEmitter.fire(undefined);
      if (!open.writing) {
         void this.writeQueued(open);
      }
      return edit.outcome.promise;
   }

   /**
    * Wait for every edit to answer, those made during the wait included, and
    * persist the server's text when it differs from the file, whoever wrote
    * it. Resolves to what the persist answered, or `undefined` when nothing
    * needed saving. Rejects with a `DocumentNotOpenError` when the copy
    * follows no document, at the call or once the edits have answered, or
    * follows one opened again meanwhile. Rejects with a `ConflictError` when
    * the text moved past the copy's version or the copy's document is from
    * before the latest restore, and with a `SaveFailedError` when an edit has
    * not answered within {@link settleWritesMs}.
    */
   async save(): Promise<TransferSavedDocument<TTransfer> | undefined> {
      this.assertLive();
      const before = this.requireOpen();
      // An edit made during the wait is written first, or the persist would be
      // gated on the version before it.
      if (!(await this.whenEditsIdle())) {
         throw new SaveFailedError([{ uri: this.uri, reason: 'an edit has not been answered' }]);
      }
      // Gone during the wait, as after a deletion, the save is not reported as
      // done, nor made on a document opened again meanwhile.
      const open = this.requireOpen();
      if (open !== before) {
         throw new DocumentNotOpenError(this.uri, this.session.clientId);
      }
      const model = open.snapshot.model;
      if (!model || !open.serverDirty) {
         return undefined;
      }
      // Gated on the copy's version: text the copy has not shown is not saved
      // on its behalf, and the save rejects with the `ConflictError` instead.
      // A version from before the latest restore names nothing on this server.
      if (open.snapshotRestores !== this.restores) {
         throw new ConflictError(this.uri, model.version, UNRECORDED_VERSION, STALE_BASE_VERSION_SAVE);
      }
      let saved: TransferSavedDocument<TTransfer> | undefined;
      open.snapshotRequests++;
      try {
         saved = await this.session.persistDocument({ uri: this.uri, baseVersion: model.version });
         return saved;
      } finally {
         this.settleRequest(open, saved, true);
      }
   }

   /**
    * Resolve to `true` once no edit is pending, those made during the wait
    * included, or to `false` once {@link settleWritesMs} has passed first.
    * Never rejects.
    */
   whenWritesSettled(): Promise<boolean> {
      return this.whenEditsIdle();
   }

   /**
    * Resolve to `true` once `opening` has settled and no edit is pending, those
    * made during the wait included, or to `false` once {@link settleWritesMs}
    * has passed first.
    */
   protected async whenEditsIdle(opening?: Promise<void>): Promise<boolean> {
      const idle = async (): Promise<void> => {
         await opening?.catch(() => undefined);
         while (!this.editsInFlight.isIdle) {
            await this.editsInFlight.whenSettled();
         }
      };
      return (!opening && this.editsInFlight.isIdle) || (await this.clock.raceTimer(idle(), this.settleWritesMs)) !== TIMED_OUT;
   }

   /**
    * Wait for an open under way and the edits, those made during the wait
    * included, up to {@link settleWritesMs}, and close the document. Final:
    * the copy does not open again, and a later call shares this one.
    */
   close(): Promise<void> {
      return (this.closing ??= this.closeAfter(this.opening));
   }

   /** The work of {@link close}, after the open it ends and the edits, within one bound. */
   protected async closeAfter(opening: Promise<void> | undefined): Promise<void> {
      let opened = !opening;
      void opening?.then(
         () => (opened = true),
         () => (opened = true)
      );
      // Waited for, so an open still under way is closed and not left behind.
      await this.whenEditsIdle(opening);
      // Not answered within the bound, the open ends when it answers, and the
      // session closes the document again then.
      this.openAbandoned = !opened;
      if (!this.current && opened) {
         return;
      }
      // An edit still queued once the bound has passed is not written to a
      // closed document.
      this.unload().forEach(edit => edit.outcome.resolve({ status: 'unavailable' }));
      await this.session.closeDocument({ uri: this.uri });
      this.changeEmitter.fire(undefined);
   }

   /**
    * Announce nothing more. Unanswered edits are still written while the
    * session lives, since dropping them would lose what the user typed, and
    * the copy follows the document until they have answered, so their writes
    * still heed a restore or a deletion. A host that ends the session as well
    * waits for {@link whenWritesSettled} first.
    */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      // Nothing listens any more, so a held document waits for its request.
      this.current?.holdTimer?.dispose();
      this.changeEmitter.dispose();
      this.dirtyEmitter.dispose();
      const unsubscribe = (): void => this.subscriptions.forEach(subscription => subscription.dispose());
      if (this.editsInFlight.isIdle) {
         unsubscribe();
      } else {
         void this.editsInFlight.whenSettled().then(unsubscribe);
      }
   }

   /** Both reads of {@link open}. */
   protected async load(): Promise<void> {
      const document = await this.session.openDocument({ uri: this.uri });
      if (this.openAbandoned) {
         throw new Error('WorkingCopy is closed');
      }
      const restores = this.restores;
      const open: WorkingCopyOpen<TTransfer> = {
         snapshot: document,
         snapshotRestores: restores,
         queued: [],
         sending: [],
         writing: false,
         serverDirty: false,
         snapshotRequests: 1,
         dirtyFromEvent: false
      };
      this.current = open;
      // Taken now, so a save while the second read is out sees the text dirty.
      this.takeDirty(open, document.text);
      // Heard apart from the restore count, which skips a restore that found the text unchanged.
      let restored = false;
      const listening = this.session.onDidRestoreDocument(event => {
         restored ||= event.uri === this.uri && event.reopened;
      });
      let answer: TransferDocument<TTransfer>;
      try {
         answer = await (await this.session.connected()).getModelDocument({ uri: this.uri, includeDiagnostics: true });
      } catch (error: unknown) {
         this.settleRequest(open, undefined);
         // After a dropped connection, the restore opens the document again
         // and hands it to the copy before the session is connected.
         await this.session.connected().catch(() => undefined);
         if (open !== this.current) {
            throw error;
         }
         // A restore took the document over, so the copy follows it and the open stands.
         if (restored) {
            return;
         }
         // Following nothing, the copy would take edits it cannot show. Undone,
         // so the open can be tried again.
         this.unload().forEach(edit => edit.outcome.resolve({ status: 'unavailable' }));
         await this.session.closeDocument({ uri: this.uri }).catch(() => undefined);
         throw error;
      } finally {
         listening.dispose();
      }
      this.settleRequest(open, answer);
      // The read found the file gone, or a deletion came meanwhile.
      if (open !== this.current) {
         throw new DocumentNotOpenError(this.uri, this.session.clientId);
      }
      this.changeEmitter.fire(undefined);
   }

   /** Write the batches of `open` until none is left, one at a time, so each can be based on the answer to the last. */
   protected async writeQueued(open: WorkingCopyOpen<TTransfer>): Promise<void> {
      open.writing = true;
      try {
         // The edits made in the same turn go out as one write.
         await Promise.resolve();
         // Once the open ended, the copy opened again writes on its own.
         while (open.queued.length > 0 && open === this.current) {
            const base = open.base;
            open.sending = open.queued;
            open.queued = [];
            open.base = undefined;
            const batch = open.sending;
            await this.writeBatch(open, batch, base).catch((error: unknown) => {
               // `writeBatch` settles its own failures, so only a subclass that
               // throws past them gets here. Settled already, an edit keeps its
               // outcome. The edits queued meanwhile may be based on this
               // batch, so their write is reconciled.
               batch.forEach(edit => edit.outcome.reject(error));
               if (open.base) {
                  open.base = { ...open.base, unconfirmed: true };
               }
            });
         }
      } finally {
         open.writing = false;
         open.sending = [];
         this.announceDirty();
      }
   }

   /**
    * Write one batch, made on `base`, and settle its edits. The batch leaves
    * {@link root} before the server's answer is taken and the one change is
    * fired for it, since a reader would otherwise apply it again over an
    * answer that holds or refused it.
    */
   protected async writeBatch(
      open: WorkingCopyOpen<TTransfer>,
      batch: WorkingCopyOpen<TTransfer>['queued'],
      base: WorkingCopyOpen<TTransfer>['base']
   ): Promise<void> {
      let answer: TransferDocument<TTransfer> | undefined;
      let settle: (edit: WorkingCopyOpen<TTransfer>['queued'][number], index: number) => void = edit =>
         edit.outcome.resolve({ status: 'unavailable' });
      let failed = true;
      let outcomes: (WorkingCopyEditOutcome | Promise<never>)[] = [];
      let seen: TTransfer | undefined;
      open.snapshotRequests++;
      if (base) {
         try {
            // The server keeps the other client's value of a field a dropped
            // edit wrote, so an edit of it conflicts, a revert included.
            const lost = writesDropped(batch, base.dropped);
            const written = batch.filter((_, index) => !lost[index]);
            const roots = written.reduce((made, edit) => [...made, edit.change(made[made.length - 1])], [base.model]);
            seen = rootOrUndefined(() => batch.reduce((root, edit) => edit.change(root), base.model));
            let writtenOutcomes: (WorkingCopyEditOutcome | Promise<never>)[] = written.map(() => ({ status: 'unchanged' }));
            // Written anyway, a batch that changes nothing would make the text dirty.
            if (compare(base.model, roots[written.length]).length > 0) {
               const reconciled = await this.reconcile(open, base, roots[written.length], true);
               answer = reconciled.answer;
               writtenOutcomes = writtenOutcomes.map(() => this.toEditOutcome(reconciled.outcome));
               if (reconciled.outcome.status === 'conflict' && written.length > 1 && answer && TransferDocument.isLoaded(answer)) {
                  ({ answer, outcomes: writtenOutcomes } = await this.splitConflict(open, roots, answer, reconciled.restores));
               }
            }
            let next = 0;
            outcomes = batch.map((_, index) => (lost[index] ? { status: 'conflict' } : writtenOutcomes[next++]));
            settle = (edit, index) => edit.outcome.resolve(outcomes[index]);
            failed = false;
         } catch (error: unknown) {
            settle = edit => edit.outcome.reject(error);
         }
      }
      open.sending = [];
      if (open.base) {
         // The edits queued meanwhile were made over this batch, which the
         // server may not hold. Gated on a version it still has, their write
         // would pass and carry it.
         if (failed) {
            open.base = open.snapshot.model && {
               model: open.snapshot.model.root,
               baseVersion: open.snapshot.model.version,
               restores: open.snapshotRestores
            };
         } else if (base && outcomes.some(isDropped)) {
            // Dropped in part over a foreign edit, so reconciled against it,
            // and measured with only the edits that were not dropped, so an
            // edit restating a dropped value conflicts too and one over a
            // merged value does not.
            const kept = keptOf(batch, outcomes, base.model);
            const dropped = seen && { seen, paths: compare(kept, seen).map(operation => operation.path) };
            open.base = { ...open.base, model: kept, unconfirmed: true, dropped };
         }
      }
      this.settleRequest(open, answer);
      this.changeEmitter.fire(undefined);
      batch.forEach(settle);
   }

   /**
    * Replay a conflicting batch onto `theirs` one edit at a time, each as the
    * change from the root before it, and write the edits that do not collide.
    * One edit's collision then drops only that edit.
    */
   protected async splitConflict(
      open: WorkingCopyOpen<TTransfer>,
      roots: readonly TTransfer[],
      theirs: LoadedTransferDocument<TTransfer>,
      restores: number
   ): Promise<{ answer?: TransferDocument<TTransfer>; outcomes: (WorkingCopyEditOutcome | Promise<never>)[] }> {
      let merged = theirs.model.root;
      const replays: ReconcileOutcome<TTransfer>['status'][] = [];
      for (let i = 1; i < roots.length; i++) {
         const current = merged;
         const replayed = await this.conflictResolver.resolve(roots[i - 1], roots[i], async () => current);
         replays.push(replayed.status);
         if (replayed.status === 'merged') {
            merged = replayed.merged;
         }
      }
      let written: WorkingCopyEditOutcome | Promise<never> = { status: 'unchanged' };
      let answer: TransferDocument<TTransfer> | undefined = theirs;
      if (replays.includes('merged')) {
         try {
            const reconciled = await this.reconcile(
               open,
               { model: theirs.model.root, baseVersion: theirs.model.version, restores },
               merged,
               false
            );
            answer = reconciled.answer ?? theirs;
            const outcome = this.toEditOutcome(reconciled.outcome);
            // Written after a conflict, so the edits raced a foreign one.
            written = outcome.status === 'applied' ? { status: 'merged' } : outcome;
         } catch (error: unknown) {
            // Only the edits it carried fail, the ones that collided still conflict.
            written = Promise.reject(error);
            written.catch(() => undefined);
         }
      }
      return {
         answer,
         outcomes: replays.map(status =>
            status === 'merged'
               ? written
               : status === 'already-applied' || status === 'no-op'
                 ? { status: 'unchanged' }
                 : { status: 'conflict' }
         )
      };
   }

   /**
    * Write `ours`, based on `base`, and reconcile a conflict. Resolves to the
    * last document the write and its rereads answered, which {@link writeBatch}
    * takes, so the copy shows the server's value for an edit the reconcile
    * dropped. `restores` is {@link restores} when its last reread was taken.
    *
    * A base from before a restore is not sent but refused as a conflict, so
    * the write is reconciled against the restarted server's document. Its
    * version could match that server's by chance and the write would land.
    * An unconfirmed base is refused the same way. Only a batch's own write,
    * `whole`, can move the base of the edits queued meanwhile.
    */
   protected async reconcile(
      open: WorkingCopyOpen<TTransfer>,
      base: NonNullable<WorkingCopyOpen<TTransfer>['base']>,
      ours: TTransfer,
      whole: boolean
   ): Promise<{
      readonly outcome: ReconcileWriteOutcome;
      readonly answer?: TransferDocument<TTransfer>;
      readonly restores: number;
   }> {
      let written: TransferDocument<TTransfer> | undefined;
      let theirs: TransferDocument<TTransfer> | undefined;
      let first = true;
      let went = false;
      // The restores heard when the version written next was read.
      let restores = base.restores;
      const outcome = await reconcileWrite(ours, base.baseVersion, {
         persist: async (model, baseVersion) => {
            const onBase = first;
            first = false;
            // Refused, not sent, on an unconfirmed base, after a restore or
            // once the document went. The reread after a document went
            // reports the edit unavailable.
            const unconfirmed = onBase && base.unconfirmed;
            if (open !== this.current || unconfirmed || (restores !== this.restores && isModelVersion(baseVersion))) {
               went = open !== this.current;
               const refused = isModelVersion(baseVersion) ? baseVersion : base.baseVersion;
               throw new ConflictError(this.uri, refused, UNRECORDED_VERSION, STALE_BASE_VERSION_UPDATE);
            }
            const answer = await this.session.updateDocument({ uri: this.uri, model, baseVersion });
            written = answer;
            // Landed unchanged, the answer is what the edits queued meanwhile
            // were made on, so their write needs no reconcile of its own. One
            // that differs may hold a later write too, whose fields they would
            // overwrite, and its version does not tell, since a write that
            // changes no text makes none.
            const queued = open.base;
            const landed = TransferDocument.isLoaded(answer) && compare(answer.model.root, model).length === 0;
            if (whole && onBase && queued?.baseVersion === base.baseVersion && landed) {
               open.base = { model: answer.model.root, baseVersion: answer.model.version, restores: this.restores };
            }
         },
         refetch: async () => {
            // Checked before the read too, since a session ended with the open rejects it.
            if (open !== this.current) {
               return undefined;
            }
            // A syncing read, so its root and version come from the same text.
            const read = await (await this.session.connected()).getModelDocument({ uri: this.uri, includeDiagnostics: true });
            // The document went meanwhile, so the edit is not written to one opened again.
            if (open !== this.current) {
               return undefined;
            }
            theirs = read;
            restores = this.restores;
            // Gone, the edit is not written, so a deleted file is not written back.
            return theirs.model && { model: theirs.model.root, baseVersion: theirs.model.version };
         },
         base: base.model,
         conflictResolver: this.conflictResolver,
         maxWrites: this.maxWrites
      });
      // A resolver that refetches nothing would retry a write refused this way until it ran out.
      if (went && outcome.status !== 'persisted') {
         return { outcome: { ...outcome, status: 'unavailable' }, answer: theirs, restores };
      }
      if (outcome.status === 'dropped') {
         // The last refetch is older than the write that conflicted after it.
         // A failed reread leaves the snapshot as it is, the edits still lost.
         const reread = await this.session
            .connected()
            .then(server => server.getModelDocument({ uri: this.uri, includeDiagnostics: true }))
            .catch(() => undefined);
         return { outcome, answer: reread, restores };
      }
      if (outcome.status === 'conflict' || outcome.status === 'already-applied' || outcome.status === 'unavailable') {
         return { outcome, answer: theirs, restores };
      }
      return { outcome, answer: written, restores };
   }

   /** The outcome an edit reports for what {@link reconcile} did. */
   protected toEditOutcome(outcome: ReconcileWriteOutcome): WorkingCopyEditOutcome {
      switch (outcome.status) {
         case 'persisted':
            return { status: 'applied' };
         case 'merged':
            return { status: 'merged' };
         case 'conflict':
         case 'dropped':
            return { status: 'conflict' };
         case 'already-applied':
         case 'unchanged':
            return { status: 'unchanged' };
         case 'unavailable':
            return { status: 'unavailable' };
      }
   }

   /** Drop the snapshot when the document's file is removed, so no edit is based on a document the server no longer has. */
   protected handleDocumentDeleted(event: { uri: string }): void {
      if (event.uri !== this.current?.snapshot.uri) {
         return;
      }
      this.dropDocument();
   }

   /** End the open as a deletion does, and settle the edits not yet written as `unavailable`. */
   protected dropDocument(): void {
      const unwritten = this.unload();
      // So `open` loads the document again.
      this.opening = undefined;
      this.changeEmitter.fire(undefined);
      unwritten.forEach(edit => edit.outcome.resolve({ status: 'unavailable' }));
   }

   /**
    * Drop the document and every edit not yet written, and return those edits
    * for the caller to settle. Made on the document that went, they never
    * reach one opened again. Requests still out answer to nothing, since a
    * late answer would bring the document back.
    */
   protected unload(): WorkingCopyOpen<TTransfer>['queued'] {
      const unwritten = this.current?.queued ?? [];
      if (this.current) {
         this.unhold(this.current);
      }
      this.current = undefined;
      this.announceDirty();
      return unwritten;
   }

   /**
    * Follow the document again after a reconnect. A restarted server numbers
    * versions afresh, so the versions held from before compare with nothing,
    * and a change made while the connection was down sent no event. Queued
    * edits keep their base, so their write is reconciled against what the
    * restarted server holds and a field changed meanwhile conflicts. A restore
    * that finds the snapshot's text at its version is not counted, as in the
    * session, so a brief drop costs no conflict.
    */
   protected handleDocumentRestored(event: DataSessionRestoreEvent<TTransfer>): void {
      const open = this.current;
      if (event.uri !== this.uri || !open) {
         return;
      }
      // The session no longer has it open, so neither does the copy.
      if (!event.reopened) {
         this.restores++;
         this.dropDocument();
         return;
      }
      // The text the copy last saw, at its version, is still named by it.
      const text = event.document?.text;
      const known = open.snapshot.text;
      if (
         !text ||
         text.version !== known?.version ||
         text.hash !== known.hash ||
         event.document?.model?.version !== open.snapshot.model?.version
      ) {
         this.restores++;
      }
      this.unhold(open);
      open.dirtyVersion = undefined;
      open.dirtyFromEvent = false;
      // The restore reads without diagnostics, so the ones held stay until
      // the reread answers.
      const kept = open.snapshot.model?.diagnostics;
      const restored =
         event.document?.model && event.document.model.diagnostics === undefined && kept
            ? { ...event.document, model: { ...event.document.model, diagnostics: kept } }
            : event.document;
      if (restored && TransferDocument.isLoaded(restored)) {
         this.takeDirty(open, restored.text);
         if (open.sending.length > 0) {
            this.hold(open, restored);
         } else {
            this.adopt(open, restored);
         }
      }
      // A listener of the adoption may have ended the open.
      if (open === this.current) {
         void this.reread(open);
      }
   }

   /** Read the document of `open` again with diagnostics, and take the answer. */
   protected async reread(open: WorkingCopyOpen<TTransfer>): Promise<void> {
      let answer: TransferDocument<TTransfer> | undefined;
      open.snapshotRequests++;
      try {
         answer = await (await this.session.connected()).getModelDocument({ uri: this.uri, includeDiagnostics: true });
      } catch {
         // The snapshot the restore read stays.
      } finally {
         this.settleRequest(open, answer, true);
      }
   }

   /** Follow a server push for the document. */
   protected handleDocumentUpdated(event: { document: TransferDocument<TTransfer>; sourceClientId: string }): void {
      const open = this.current;
      if (!open || event.document.uri !== open.snapshot.uri) {
         return;
      }
      // While a request is out, the write's answer carries it. With none out
      // it may be a late write of a copy before this one, and `offer` skips
      // an echo older than the snapshot.
      if (open.snapshotRequests > 0 && this.session.isOwnEcho(event.sourceClientId)) {
         return;
      }
      this.offer(open, event.document, true);
   }

   /**
    * Take the dirty flag of a document the server sent, and the document itself
    * unless a request is out. A document older than the snapshot is skipped.
    */
   protected offer(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>, announce: boolean): void {
      // Versions rise per server, so an older one was built before the
      // snapshot. Held, it would be taken when a request answers.
      const offered = document.model?.version;
      const current = open.snapshot.model?.version;
      if (offered !== undefined && current !== undefined && offered < current && open.snapshotRestores === this.restores) {
         return;
      }
      this.takeDirty(open, document.text);
      if (open.snapshotRequests > 0) {
         const held = open.held?.model?.version;
         if (held === undefined || offered === undefined || offered >= held) {
            this.hold(open, document);
         }
         return;
      }
      this.adopt(open, document, announce);
   }

   /**
    * Hold `document` until a request answers. A document first held
    * {@link settleWritesMs} ago is taken then, so a request that hangs does
    * not hide other clients' changes for longer.
    */
   protected hold(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>): void {
      open.held = document;
      if (this.disposed) {
         return;
      }
      open.holdTimer ??= this.clock.setTimer(() => {
         const held = this.unhold(open);
         if (open === this.current && held) {
            this.adopt(open, held);
         }
      }, this.settleWritesMs);
   }

   /** Stop holding a document for `open`, and return the one it held. */
   protected unhold(open: WorkingCopyOpen<TTransfer>): TransferDocument<TTransfer> | undefined {
      const held = open.held;
      open.held = undefined;
      open.holdTimer?.dispose();
      open.holdTimer = undefined;
      return held;
   }

   /**
    * Take `document` as the new snapshot. Fires a change unless the model's
    * hash is the one held, which also means equally validated, or `announce`
    * is false, as for a write's answers, which {@link writeBatch} announces
    * once the write's edits are off {@link root}.
    */
   protected adopt(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>, announce = true): void {
      const held = open.snapshot.model?.hash;
      open.snapshot = document;
      open.snapshotRestores = this.restores;
      open.snapshotUnderWrite = open.sending.length > 0;
      if (announce && (held === undefined || held !== document.model?.hash)) {
         this.changeEmitter.fire(undefined);
      }
   }

   /**
    * End a request, and take the newest document the server sent while
    * requests were out, its answer included. None is taken while a write is
    * out, since it may already hold that write's edits, which {@link root}
    * would then apply again. Versions are compared only within that window,
    * and a restore clears what it held, since a restarted server numbers
    * afresh. {@link dirty} is announced once the answer is taken.
    */
   protected settleRequest(open: WorkingCopyOpen<TTransfer>, answer: TransferDocument<TTransfer> | undefined, announce = false): void {
      if (open !== this.current) {
         return;
      }
      this.settling++;
      try {
         this.settleAnswer(open, answer, announce);
      } finally {
         this.settling--;
      }
      this.announceDirty();
   }

   /** {@link settleRequest} past its check that `open` is followed, without announcing {@link dirty}. */
   protected settleAnswer(open: WorkingCopyOpen<TTransfer>, answer: TransferDocument<TTransfer> | undefined, announce: boolean): void {
      // A read found the file gone, and a deletion event need not follow, so
      // the session's open is closed too. An open called later follows it.
      if (answer && !TransferDocument.isLoaded(answer)) {
         // Closed first, so an open a listener of the drop calls is not closed.
         void this.session.closeDocument({ uri: this.uri }).catch(() => undefined);
         this.dropDocument();
         return;
      }
      if (answer) {
         this.offer(open, answer, announce);
      }
      open.snapshotRequests--;
      // Taken with other requests still out, it is held no longer, so its
      // timer does not take it again over a write sent meanwhile.
      if (open.snapshotRequests === 0 || open.sending.length === 0) {
         const held = this.unhold(open);
         if (held && open.sending.length === 0) {
            this.adopt(open, held, announce);
         }
      }
   }

   /**
    * Take a dirty flag the server sent, `announced` when it came as a dirty
    * event. While a request is out, one decided on older text than the last
    * is skipped, and so is a document's at the version of the last event,
    * since a save changes the flag but not the version, and that document may
    * have been built before it. Outside that window any is taken, as after a
    * restart that numbers versions afresh.
    */
   protected takeDirty(
      open: WorkingCopyOpen<TTransfer>,
      text: (Pick<TextState, 'dirty'> & Partial<Pick<TextState, 'version'>>) | undefined,
      announced = false
   ): void {
      if (!text) {
         return;
      }
      if (open.snapshotRequests > 0 && open.dirtyVersion !== undefined && text.version !== undefined) {
         if (text.version < open.dirtyVersion || (text.version === open.dirtyVersion && open.dirtyFromEvent && !announced)) {
            return;
         }
      }
      open.dirtyVersion = text.version ?? open.dirtyVersion;
      open.dirtyFromEvent = announced;
      open.serverDirty = text.dirty;
      this.announceDirty();
   }

   /** Fire {@link onDidChangeDirty} when {@link dirty} differs from what was last announced, unless a request is being settled. */
   protected announceDirty(): void {
      const dirty = this.dirty;
      if (this.settling === 0 && dirty !== this.announcedDirty) {
         this.announcedDirty = dirty;
         this.dirtyEmitter.fire(undefined);
      }
   }

   /** The open the copy follows, or a throw when it follows none. */
   protected requireOpen(): WorkingCopyOpen<TTransfer> {
      if (!this.current) {
         throw new DocumentNotOpenError(this.uri, this.session.clientId);
      }
      return this.current;
   }

   /** Throw once {@link dispose} ran. */
   protected assertLive(): void {
      if (this.disposed) {
         throw new Error('WorkingCopy is disposed');
      }
   }
}
