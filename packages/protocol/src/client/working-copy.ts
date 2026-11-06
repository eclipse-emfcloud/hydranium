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
import {
   ConflictError,
   DocumentNotOpenError,
   isConflictError,
   SaveFailedError,
   SessionClosedError,
   STALE_BASE_VERSION_UPDATE
} from '../errors';
import { type BaseVersion, isModelVersion, type ModelVersion, UNRECORDED_VERSION } from '../model-service/base-version';
import {
   changedPaths,
   type ConflictResolver,
   editRoot,
   type ReconcileOutcome,
   ReconcilingConflictResolver,
   type ReplayOptions
} from '../patch-merge';
import { PendingWorkTracker } from '../pending-work-tracker';
import { type ReconcileWriteOutcome, reconcileWrite, type VersionedModel } from '../reconcile-write';
import type { TransferDiagnostic } from '../transfer-diagnostic';
import { type LoadedTransferDocument, type TextState, TransferDocument, type TransferSavedDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';
import { Deferred } from '../util';
import type { DataEvents } from './data-events';
import type { DataSession, DataSessionRegisterEvent, DataSessionRestoreEvent } from './data-session';

/** What the write that carried an {@link WorkingCopy.edit} did. */
export type WorkingCopyEditOutcome =
   /** The write landed against an unchanged document. */
   | { readonly status: 'applied' }
   /** The write raced a foreign edit to other paths, and both landed. */
   | { readonly status: 'merged' }
   /**
    * The edit raced a foreign edit of the same path and was dropped, or wrote a
    * path an edit before it lost. The copy shows the server's value. When the
    * read after the last race fails, the edit rejects instead.
    */
   | { readonly status: 'conflict' }
   /**
    * Each write conflicted, as other clients kept changing the document, until
    * the writes ran out, and the edit was dropped. A retry may land. The copy
    * shows the server's value. When the read after the last write fails, the
    * edit rejects instead.
    */
   | { readonly status: 'ran-out' }
   /** Nothing was written: the server already held the edit, or it changed nothing. */
   | { readonly status: 'unchanged' }
   /**
    * Nothing was written, because the copy was closed, its file deleted, a
    * restore could not open it again or its open's second read failed, before
    * a write carried the edit.
    */
   | { readonly status: 'unavailable' };

/**
 * Why {@link WorkingCopy.onDidChange} fired. `edited`: an
 * {@link WorkingCopy.edit} shows, on the root as the copy holds it.
 * `written`: the answer to the copy's own write, holding nothing else. It may
 * differ from the edit where the server computes values. `changed`:
 * everything else, which may hold another client's write.
 */
export type WorkingCopyChangeReason = 'edited' | 'written' | 'changed';

/** What {@link WorkingCopy.onDidChange} carries. */
export interface WorkingCopyChangeEvent {
   readonly reason: WorkingCopyChangeReason;
}

/**
 * One open of a {@link WorkingCopy}, from the answer to its open until a
 * close, a deletion or a failure ends it. A request records its answer only
 * while the open it was sent under is still the copy's, so nothing of an
 * ended open reaches the next.
 */
export interface WorkingCopyOpen<TTransfer extends TransferElement> {
   /** The last document the server sent. */
   snapshot: TransferDocument<TTransfer>;
   /**
    * Whether {@link snapshot} was taken while a write was out, from a server
    * that reports no writes, so it may hold the edits {@link sending} applies
    * again. A base made on it then is unconfirmed, so its first write is
    * reconciled, not sent.
    */
   snapshotUnderWrite?: boolean;
   /** Edits not yet written, in edit order, each until the write that carries it answers. */
   queued: { readonly change: (root: TTransfer) => TTransfer; readonly outcome: Deferred<WorkingCopyEditOutcome> }[];
   /**
    * The root the first queued edit was made on, the write in flight
    * included, and the snapshot version their write is gated on. A foreign
    * update that lands while they wait then conflicts and is reconciled,
    * instead of being written over, and the copy's own write does not.
    * `epoch` is the server's when that root was taken. A server that does not
    * have it refuses the base's first write. `unconfirmed` marks a base whose
    * write before a conflict dropped edits from. The root is then the
    * snapshot's it was made on with only the edits that write kept, so an
    * edit restating a dropped value conflicts, and its first write conflicts
    * too. It also marks a base made on a {@link snapshotUnderWrite}.
    * `dropped` makes any edit of a path a dropped edit wrote conflict, a
    * revert to the value before it included.
    */
   base?: VersionedModel<TTransfer> & {
      readonly epoch: string;
      readonly unconfirmed?: boolean;
      /**
       * The root the user saw before a conflict dropped edits, but for edits
       * whose writes ran out, and the same root without the dropped edits.
       */
      readonly dropped?: { readonly kept: TTransfer; readonly seen: TTransfer };
      /** The snapshot's root the base was made on with the write out's edits over it, absent when the snapshot held them. */
      readonly onto?: TTransfer;
   };
   /** Edits of the write in flight, in edit order. */
   sending: WorkingCopyOpen<TTransfer>['queued'];
   /**
    * The number of the first write sent for {@link sending}. A document whose
    * `heldWrites` reaches it holds them, since a batch lands one write at most
    * and the copy writes one batch at a time.
    */
   sendingWrite?: number;
   /** Whether a write loop runs. */
   writing: boolean;
   /** The server's dirty flag, as last sent. */
   serverDirty: boolean;
   /** Requests out whose answer replaces the snapshot. */
   snapshotRequests: number;
   /**
    * The newest document without `heldWrites` the server sent while a request
    * is out, held until a request answers with no write out, or for
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
   dropped: { readonly kept: TTransfer; readonly seen: TTransfer } | undefined,
   options: ReplayOptions
): boolean[] {
   if (!dropped) {
      return batch.map(() => false);
   }
   // An edit that throws, and every one after it, writes nothing.
   const roots = [dropped.kept, dropped.seen];
   for (const edit of batch) {
      const root = rootOrUndefined(() => edit.change(roots[roots.length - 1]));
      if (root === undefined) {
         break;
      }
      roots.push(root);
   }
   // One call, so an array is addressed by key in every change or in none.
   const [droppedPaths, ...editPaths] = changedPaths(roots, options);
   const overlaps = (path: string): boolean =>
      droppedPaths.some(droppedPath => path === droppedPath || path.startsWith(`${droppedPath}/`) || droppedPath.startsWith(`${path}/`));
   return batch.map((_, index) => editPaths[index]?.some(overlaps) ?? false);
}

/**
 * `base` with the edits of `batch` whose `outcomes` `left` does not match, or
 * `base` alone when one of those throws on it.
 */
function keptOf<TTransfer>(
   batch: readonly { readonly change: (root: TTransfer) => TTransfer }[],
   outcomes: readonly (WorkingCopyEditOutcome | Promise<never>)[],
   base: TTransfer,
   left: (outcome: WorkingCopyEditOutcome | Promise<never>) => boolean = isDropped
): TTransfer {
   return rootOrUndefined(() => batch.reduce((root, edit, index) => (left(outcomes[index]) ? root : edit.change(root)), base)) ?? base;
}

/** The highest write of `clientId` that `document` holds, as its `heldWrites` names it. */
function heldWriteOf(document: TransferDocument<TransferElement>, clientId: string): number | undefined {
   const heldWrites: Record<string, number> | undefined = document.heldWrites;
   // Own keys only, so a session named `__proto__` reads its own entry, not the prototype.
   return heldWrites && Object.hasOwn(heldWrites, clientId) ? heldWrites[clientId] : undefined;
}

/** Whether `document` reports the writes it holds, which one from a server before `heldWrites` does not. */
function reportsWrites(document: TransferDocument<TransferElement>): boolean {
   const heldWrites: Record<string, number> | undefined = document.heldWrites;
   return heldWrites !== undefined;
}

/** Whether a batch's edit did not reach the server: a conflict dropped it, its writes ran out, or its write failed. */
function isDropped(outcome: WorkingCopyEditOutcome | Promise<never>): boolean {
   return isLost(outcome) || ('status' in outcome && outcome.status === 'ran-out');
}

/**
 * Whether a batch's edit was dropped with a value the server may keep: a
 * conflict's, or one a failed write left unknown. A run-out sets no value.
 */
function isLost(outcome: WorkingCopyEditOutcome | Promise<never>): boolean {
   return !('status' in outcome) || outcome.status === 'conflict';
}

/**
 * How a {@link WorkingCopy} matches the edits it replays. Its reconcile, its
 * {@link WorkingCopy.editRoot}, and its check whether a later edit writes what
 * a dropped one wrote all take these options, so they match an array by the
 * same key.
 */
export type WorkingCopyOptions = ReplayOptions;

/**
 * The client's working copy of one data-server document: the server's latest
 * snapshot of it, plus the edits the server has not confirmed yet.
 *
 * - **Follows the server.** Every document the server sends replaces the
 *   snapshot at once, unless it is older, and fires {@link onDidChange}. The
 *   copy's own echo of its write out fires with the write's answer instead,
 *   however long that takes.
 *   {@link root} applies the edits of the write out on top only while the
 *   snapshot does not hold that write, as its `heldWrites` tells. From a
 *   server that reports no writes, a document sent while a request is out
 *   waits, as it may hold the write out. The newest is taken when a request
 *   answers and no write is out, or once the first has waited
 *   {@link settleWritesMs}.
 * - **Batches edits behind a write.** An edit goes out at once when no write
 *   is out. The edits made while one is out go out after it, as one write of
 *   the whole root, gated on the version of the snapshot the first of them
 *   was made on, or of the answer to the copy's write before when that was
 *   built from the write's own text or holds its model unchanged. Each edit
 *   resolves to a {@link WorkingCopyEditOutcome}, its batch's unless the
 *   batch splits on a conflict.
 * - **Reconciles.** A write that meets a newer version goes through
 *   `reconcileWrite`: the edits are replayed onto the refetched root, and a
 *   same-path collision drops the edit that made it in favour of the
 *   server's value. The other edits of its batch are still written.
 * - **Counts its own edits as dirty.** {@link dirty} is the server's flag, or
 *   true while an edit is unanswered, so a host never shows clean text with
 *   an edit still on its way.
 *
 * The copy is the only writer of the document on its session. A late write
 * of a copy before it is taken as another client's.
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
   protected readonly changeEmitter = new Emitter<WorkingCopyChangeEvent>();
   /**
    * Fires when {@link root} or {@link diagnostics} may have changed, with why.
    * The copy's own echo of its write out changes them before its write's
    * answer fires, and a batch that writes nothing fires only for a change.
    */
   readonly onDidChange: Event<WorkingCopyChangeEvent> = this.changeEmitter.event;
   protected readonly dirtyEmitter = new Emitter<void>();
   /** Fires whenever {@link dirty} changes. Apart from {@link onDidChange}, since a save changes no content. */
   readonly onDidChangeDirty: Event<void> = this.dirtyEmitter.event;

   /**
    * Asked for each conflicting write, see {@link reconcile}. Made from
    * {@link replayOptions}. An override that should match by key passes them
    * to its resolver.
    */
   protected readonly conflictResolver: ConflictResolver;
   /**
    * Writes of one reconcile, the first included, after which a conflict that
    * would still merge is dropped. A write the copy refuses unsent, on a base
    * a conflict dropped edits from, does not count, up to as many as the cap.
    * A split batch reconciles twice, so one batch makes at most twice the cap
    * of writes. Absent, `reconcileWrite`'s default applies.
    */
   protected readonly maxWrites?: number;
   /**
    * How long {@link close}, {@link whenWritesSettled} and each attempt of
    * {@link save} wait for the copy's edits before going on anyway, and how
    * long a document from a server that reports no writes is held for a
    * request at most.
    */
   protected readonly settleWritesMs: number = 30_000;
   /** The clock of {@link settleWritesMs}. */
   protected readonly clock: Clock = new SystemClock();

   /**
    * The open the copy follows. A close, a deletion or a failure ends it, and a
    * request sent under an earlier one neither counts nor answers.
    */
   protected current?: WorkingCopyOpen<TTransfer>;
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
   /**
    * The epoch the session's last registration answered, `undefined` until it
    * registers again after the copy was made.
    */
   protected registeredEpoch?: string;
   /** Set once {@link close} stopped waiting for the open, which then ends when it answers. */
   protected openAbandoned = false;
   /**
    * While {@link load} waits for the open, the server URIs of the updates and
    * dirty flips heard, which the open's answer may be older than.
    */
   protected heardWhileLoading?: Set<string>;

   constructor(
      protected readonly session: DataSession<TTransfer>,
      protected readonly events: DataEvents<TTransfer>,
      /** The document followed, as the caller spells it, which the session keys its open by. */
      readonly uri: string,
      /** How the copy matches the edits it replays, see {@link WorkingCopyOptions}. */
      protected readonly replayOptions: WorkingCopyOptions = {}
   ) {
      // Set here, since a field initializer runs before `replayOptions` is assigned.
      this.conflictResolver = new ReconcilingConflictResolver(replayOptions);
      // A deletion carries no document, so it has a channel of its own.
      this.subscriptions = [
         session.onDidRegister(event => this.handleRegistered(event)),
         events.onDidUpdateDocument(event => this.handleDocumentUpdated(event)),
         events.onDidDeleteDocument(event => this.handleDocumentDeleted(event)),
         events.onDidChangeDocumentDirty(event => {
            const open = this.current;
            if (!open) {
               this.heardWhileLoading?.add(event.uri);
            } else if (event.uri === open.snapshot.uri) {
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
      const unheld = open && !this.holdsSending(open, open.snapshot) ? open.sending : [];
      return root && [...unheld, ...(open?.queued ?? [])].reduce((edited, edit) => edit.change(edited), root);
   }

   /**
    * Diagnostics as of the last snapshot. A write answers once its document is
    * validated, so they hold for the copy's own edits without an update push.
    * After a reconnect the restored document's, or when the session restores
    * without them, the ones from before until the copy's reread answers, or
    * the next update when that fails.
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
    * Open and watch the document, in one request that answers once it is
    * validated, so a document that was never edited reports its problems.
    * While others keep editing it, the answer may come before that, and the
    * problems with a later change. A change that reached the client before
    * the answer, or a server that ignores `watch`, costs a second read. Fires
    * a change once the open answered. Repeated calls share the first one, and
    * a failed open may be retried. Rejects once {@link close} was called,
    * with the server's error, as when the second read fails, or a
    * `DocumentNotOpenError` when the file is missing or deleted while the
    * open is out, a `SessionClosedError` when the session ends meanwhile, and
    * as the session's open does, also when the connection drops while it is
    * out.
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
      const sent = this.holdsSending(open, loaded) ? [] : open.sending;
      open.base ??= {
         // A sent edit that throws on this root is measured as none.
         model: rootOrUndefined(() => sent.reduce((root, edit) => edit.change(root), loaded.model.root)) ?? loaded.model.root,
         baseVersion: loaded.model.version,
         epoch: loaded.epoch,
         unconfirmed: (open.snapshotUnderWrite && open.sending.length > 0) || undefined,
         onto: sent.length > 0 ? loaded.model.root : undefined
      };
      open.queued.push(edit);
      this.editsInFlight.track(edit.outcome.promise).catch(() => undefined);
      this.announceDirty();
      this.changeEmitter.fire({ reason: 'edited' });
      if (!open.writing) {
         void this.writeQueued(open);
      }
      return edit.outcome.promise;
   }

   /**
    * {@link edit} with the change from `before` to `after`, replayed on each
    * newer root with {@link replayOptions}. For a form that hands back a whole
    * new root. `before` is the root the form edited, not the copy's current
    * one, which would undo another client's update the form never showed.
    */
   editRoot(before: TTransfer, after: TTransfer): Promise<WorkingCopyEditOutcome> {
      return this.edit(editRoot(before, after, this.replayOptions));
   }

   /**
    * Wait for every edit to answer, those made during the wait included, and
    * persist the server's text when it differs from the file, whoever wrote
    * it. Resolves to what the persist answered, or `undefined` when nothing
    * needed saving. Rejects with a `DocumentNotOpenError` when the copy
    * follows no document, at the call or once the edits have answered, or
    * follows one opened again meanwhile. Rejects when the copy is disposed,
    * at the call or once the edits have answered.
    *
    * When the text moved past the copy's version or the server restarted
    * since the copy's document, the persist conflicts. The server need not
    * have pushed the newer text yet, so the copy reads the document again,
    * announces it, and saves once more. Rejects with the `ConflictError`
    * when that save conflicts too. Rejects with a `SaveFailedError` when an
    * edit has not answered within {@link settleWritesMs}, or when
    * {@link canPersist} declines either save.
    */
   async save(): Promise<TransferSavedDocument<TTransfer> | undefined> {
      this.assertLive();
      const before = this.requireOpen();
      try {
         return await this.saveOnce(before);
      } catch (error: unknown) {
         if (!isConflictError(error)) {
            throw error;
         }
      }
      await this.reread(before);
      return this.saveOnce(before);
   }

   /**
    * Whether {@link save} may persist the server's text at `snapshot`, the
    * text the copy shows. Asked before each persist. A no rejects the save
    * with a `SaveFailedError`, and the document stays dirty.
    */
   protected canPersist(_snapshot: TransferDocument<TTransfer>): boolean {
      return true;
   }

   /** One attempt of {@link save}, for the open `before` it was called under. */
   protected async saveOnce(before: WorkingCopyOpen<TTransfer>): Promise<TransferSavedDocument<TTransfer> | undefined> {
      // An edit made during the wait is written first, or the persist would be
      // gated on the version before it.
      if (!(await this.whenEditsIdle())) {
         throw new SaveFailedError([{ uri: this.uri, reason: 'an edit has not been answered' }]);
      }
      // Disposed during the wait, the copy announces no text it takes, so it
      // saves none on its own behalf.
      this.assertLive();
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
      if (!this.canPersist(open.snapshot)) {
         throw new SaveFailedError([{ uri: this.uri, reason: 'the host declined to save it' }]);
      }
      // Gated on the copy's version: text the copy has not shown is not saved
      // on its behalf, and the attempt rejects with the `ConflictError`
      // instead.
      let saved: TransferSavedDocument<TTransfer> | undefined;
      open.snapshotRequests++;
      try {
         saved = await this.session.persistDocument({ uri: this.uri, baseVersion: model.version, baseEpoch: open.snapshot.epoch });
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
      this.changeEmitter.fire({ reason: 'changed' });
   }

   /**
    * Announce nothing more. Unanswered edits are still written while the
    * session lives, since dropping them would lose what the user typed, and
    * the copy follows the document until they have answered, so their writes
    * still heed a restore or a deletion. A host that ends the session as well
    * waits for {@link whenWritesSettled} first. A {@link save} under way
    * rejects before it persists, so a host that saves before disposing awaits
    * the save first.
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

   /** The request of {@link open}. */
   protected async load(): Promise<void> {
      const heard = new Set<string>();
      this.heardWhileLoading = heard;
      let document: TransferDocument<TTransfer>;
      try {
         document = await this.session.openDocument({ uri: this.uri, includeDiagnostics: true });
      } finally {
         this.heardWhileLoading = undefined;
      }
      if (this.openAbandoned) {
         throw new Error('WorkingCopy is closed');
      }
      // The file is gone, and a deletion event need not follow, so the session's open is closed too.
      if (!TransferDocument.isLoaded(document)) {
         await this.session.closeDocument({ uri: this.uri }).catch(() => undefined);
         throw new DocumentNotOpenError(this.uri, this.session.clientId);
      }
      const open: WorkingCopyOpen<TTransfer> = {
         snapshot: document,
         queued: [],
         sending: [],
         writing: false,
         serverDirty: false,
         snapshotRequests: 0,
         dirtyFromEvent: false
      };
      this.current = open;
      this.takeDirty(open, document.text);
      // The server watches from the state it answered, but a change made
      // before the answer went out reaches the client first. An answer without
      // `sequence` was watched in a second request, missing what came between.
      if (heard.has(document.uri) || document.sequence === undefined) {
         await this.loadAgain(open);
      }
      // Its open answered as the session ended, which closed the document again.
      if (this.session.isDisposed) {
         this.unload().forEach(edit => edit.outcome.resolve({ status: 'unavailable' }));
         throw new SessionClosedError(this.session.clientId);
      }
      this.changeEmitter.fire({ reason: 'changed' });
   }

   /**
    * Read the document of `open` again within {@link load}. A failed read
    * rejects the open, as the answer it has may be older than a change heard,
    * unless a restore took the document over meanwhile.
    */
   protected async loadAgain(open: WorkingCopyOpen<TTransfer>): Promise<void> {
      // Whether a restore took the document over while the read was out.
      let restored = false;
      const listening = this.session.onDidRestoreDocument(event => {
         restored ||= event.uri === this.uri && event.reopened;
      });
      let answer: TransferDocument<TTransfer>;
      open.snapshotRequests++;
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
         // Undone, so the open can be tried again.
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
         open.sendingWrite = undefined;
         this.announceDirty();
      }
   }

   /**
    * Write one batch, made on `base`, and settle its edits. The batch leaves
    * {@link root} before the server's answer is taken and the one change is
    * fired for it, since a reader would otherwise apply it again over an
    * answer that holds or refused it. A batch that wrote nothing fires only
    * when {@link root} or {@link diagnostics} changed.
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
      let own = false;
      let sent = false;
      let outcomes: (WorkingCopyEditOutcome | Promise<never>)[] = [];
      open.snapshotRequests++;
      if (base) {
         try {
            // The server keeps the other client's value of a field a lost edit
            // wrote, so an edit of it conflicts, a revert included.
            const lost = writesDropped(batch, base.dropped, this.replayOptions);
            const written = batch.filter((_, index) => !lost[index]);
            const roots = written.reduce((made, edit) => [...made, edit.change(made[made.length - 1])], [base.model]);
            let writtenOutcomes: (WorkingCopyEditOutcome | Promise<never>)[] = written.map(() => ({ status: 'unchanged' }));
            // Written anyway, a batch that changes nothing would make the text dirty.
            if (compare(base.model, roots[written.length]).length > 0) {
               sent = true;
               const reconciled = await this.reconcile(open, base, roots[written.length], true);
               answer = reconciled.answer;
               own = reconciled.own === true;
               writtenOutcomes = writtenOutcomes.map(() => this.toEditOutcome(reconciled.outcome));
               if (reconciled.outcome.status === 'conflict' && written.length > 1 && answer && TransferDocument.isLoaded(answer)) {
                  ({ answer, outcomes: writtenOutcomes } = await this.splitConflict(open, roots, answer));
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
      // A batch that wrote nothing announces only a change, so a form that
      // renders on `changed` keeps input it has not committed yet.
      const unsent = sent || failed ? undefined : { root: rootOrUndefined(() => this.root), diagnostics: [...this.diagnostics] };
      open.sending = [];
      open.sendingWrite = undefined;
      if (open.base) {
         // The edits queued meanwhile were made over this batch, which the
         // server may not hold. Gated on a version it still has, their write
         // would pass and carry it.
         if (failed) {
            open.base = open.snapshot.model && {
               model: open.snapshot.model.root,
               baseVersion: open.snapshot.model.version,
               epoch: open.snapshot.epoch
            };
         } else if (open.base.onto && outcomes.some(isDropped)) {
            // Dropped in part over a foreign edit, so reconciled against it,
            // and measured with only the edits that were not dropped, so an
            // edit restating a lost value conflicts too and one over a merged
            // or run-out value does not. Rebuilt on the root the base was made
            // on, which a document taken during the write may have moved past
            // the batch's.
            const onto = open.base.onto;
            const kept = keptOf(batch, outcomes, onto);
            // What the user saw but for a run-out's edits, which set no value.
            const seen = keptOf(batch, outcomes, onto, outcome => isDropped(outcome) && !isLost(outcome));
            const dropped = { kept, seen };
            open.base = { ...open.base, model: kept, unconfirmed: true, dropped, onto: undefined };
         }
      }
      this.settleRequest(open, answer);
      const shown = unsent && { root: rootOrUndefined(() => this.root), diagnostics: [...this.diagnostics] };
      const unchanged = unsent?.root !== undefined && shown?.root !== undefined && compare(unsent, shown).length === 0;
      if (!unchanged) {
         // Skipped as older, or followed by a held document, the answer is not what shows.
         this.changeEmitter.fire({ reason: own && open.snapshot === answer ? 'written' : 'changed' });
      }
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
      theirs: LoadedTransferDocument<TTransfer>
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
               { model: theirs.model.root, baseVersion: theirs.model.version, epoch: theirs.epoch },
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
    * dropped.
    *
    * Each write carries the epoch of the document its version came from, so
    * a restarted server refuses a version it numbered for other text. An
    * unconfirmed base is refused unsent. Only a batch's own write, `whole`,
    * can move the base of the edits queued meanwhile.
    *
    * A merged write comes back as `persisted` when it was gated on a reread
    * that equals the root the edit was made on, since it raced no foreign
    * edit. It then carries no `conflict` or `writes`.
    *
    * `own` is true when the first write, gated on `base`'s version, went
    * through and its answer is built from its text alone, so it holds no
    * other write. A merged write that comes back as `persisted` is not own,
    * since its gate came from a reread.
    */
   protected async reconcile(
      open: WorkingCopyOpen<TTransfer>,
      base: NonNullable<WorkingCopyOpen<TTransfer>['base']>,
      ours: TTransfer,
      whole: boolean
   ): Promise<{
      readonly outcome: ReconcileWriteOutcome;
      readonly answer?: TransferDocument<TTransfer>;
      readonly own?: boolean;
   }> {
      let written: TransferDocument<TTransfer> | undefined;
      // Whether the answer that landed was built from its write's text alone.
      let alone = false;
      let theirs: TransferDocument<TTransfer> | undefined;
      // Whether theirs was read after the last write's conflict.
      let readAfterWrite = false;
      // The version the write that landed was gated on.
      let landedOn: BaseVersion | undefined;
      let first = true;
      let went = false;
      // The epoch of the version written next.
      let epoch = base.epoch;
      const unsent = new Set<ConflictError>();
      const outcome = await reconcileWrite(ours, base.baseVersion, {
         persist: async (model, baseVersion) => {
            const onBase = first;
            first = false;
            readAfterWrite = false;
            // Refused, not sent, on an unconfirmed base or once the document
            // went. The reread after a document went reports the edit
            // unavailable.
            const unconfirmed = onBase && base.unconfirmed;
            if (open !== this.current || unconfirmed) {
               went = open !== this.current;
               const refused = new ConflictError(
                  this.uri,
                  isModelVersion(baseVersion) ? baseVersion : base.baseVersion,
                  UNRECORDED_VERSION,
                  STALE_BASE_VERSION_UPDATE
               );
               unsent.add(refused);
               throw refused;
            }
            const gate = isModelVersion(baseVersion) ? { baseVersion, baseEpoch: epoch } : { baseVersion };
            // Told as the write goes out, so a document that holds it is known as soon as it arrives.
            const onWrite = (write: number): void => {
               open.sendingWrite ??= write;
            };
            const answer = await this.session.updateDocument({ uri: this.uri, model, ...gate, onWrite });
            written = answer;
            landedOn = baseVersion;
            alone = TransferDocument.isLoaded(answer) && answer.model.version === answer.written.version;
            // The queued edits were made on the answer when it was built from
            // the write's own text, normalized or not, or holds its model
            // unchanged. Otherwise it holds another write they must reconcile.
            // Their base may have moved during the write, to a document that
            // holds exactly what it wrote.
            const queued = open.base;
            const landed =
               TransferDocument.isLoaded(answer) &&
               (answer.model.version === answer.written.version || compare(answer.model.root, model).length === 0);
            const madeOnWrite = queued && (queued.baseVersion === base.baseVersion || compare(queued.model, model).length === 0);
            if (whole && onBase && madeOnWrite && landed) {
               open.base = { model: answer.model.root, baseVersion: answer.model.version, epoch: answer.epoch };
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
            epoch = read.epoch;
            readAfterWrite = true;
            // Gone, the edit is not written, so a deleted file is not written back.
            return theirs.model && { model: theirs.model.root, baseVersion: theirs.model.version };
         },
         base: base.model,
         conflictResolver: this.conflictResolver,
         maxWrites: this.maxWrites,
         sent: conflict => !unsent.has(conflict)
      });
      // A resolver that refetches nothing would retry a write refused this way until it ran out.
      if (went && outcome.status !== 'persisted') {
         return { outcome: { ...outcome, status: 'unavailable' }, answer: theirs };
      }
      // A resolver that read nothing after the last write leaves the copy without the server's value.
      // A failed reread rejects, as a failed read after the last write does.
      if (outcome.status === 'dropped' && !readAfterWrite) {
         const reread = await (await this.session.connected()).getModelDocument({ uri: this.uri, includeDiagnostics: true });
         return { outcome, answer: reread };
      }
      // A dropped write too was resolved against a read after its conflict.
      if (
         outcome.status === 'dropped' ||
         outcome.status === 'conflict' ||
         outcome.status === 'already-applied' ||
         outcome.status === 'unavailable'
      ) {
         return { outcome, answer: theirs };
      }
      // Gated on a reread that equals the root the edit was made on, the write
      // raced no foreign edit, as one a restarted server refused.
      if (
         outcome.status === 'merged' &&
         theirs?.model &&
         landedOn === theirs.model.version &&
         compare(theirs.model.root, base.dropped?.seen ?? base.model).length === 0
      ) {
         return { outcome: { status: 'persisted' }, answer: written };
      }
      // `reconcileWrite` reports `persisted` only when its first write went through.
      return { outcome, answer: written, own: outcome.status === 'persisted' && alone };
   }

   /** The outcome an edit reports for what {@link reconcile} did. */
   protected toEditOutcome(outcome: ReconcileWriteOutcome): WorkingCopyEditOutcome {
      switch (outcome.status) {
         case 'persisted':
            return { status: 'applied' };
         case 'merged':
            return { status: 'merged' };
         case 'conflict':
            return { status: 'conflict' };
         case 'dropped':
            return { status: 'ran-out' };
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
      this.changeEmitter.fire({ reason: 'changed' });
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
    * restarted server holds and a field changed meanwhile conflicts. The
    * epoch they carry tells that server's versions from those held before.
    */
   protected handleDocumentRestored(event: DataSessionRestoreEvent<TTransfer>): void {
      const open = this.current;
      if (event.uri !== this.uri || !open) {
         return;
      }
      // The session no longer has it open, so neither does the copy.
      if (!event.reopened) {
         this.dropDocument();
         return;
      }
      this.unhold(open);
      open.dirtyVersion = undefined;
      open.dirtyFromEvent = false;
      // A session that restores without diagnostics leaves the ones held
      // until the reread answers.
      const kept = open.snapshot.model?.diagnostics;
      const restored =
         event.document?.model && event.document.model.diagnostics === undefined && kept
            ? { ...event.document, model: { ...event.document.model, diagnostics: kept } }
            : event.document;
      // Taken with its diagnostics, it is what a reread would answer. One
      // older than a change heard meanwhile is not taken, and read again.
      let complete = false;
      if (restored && TransferDocument.isLoaded(restored) && !this.builtBefore(open, restored)) {
         this.takeDirty(open, restored.text);
         if (open.sending.length > 0 && !reportsWrites(restored)) {
            this.hold(open, restored);
         } else {
            this.adopt(open, restored);
            complete = event.document?.model?.diagnostics !== undefined;
         }
      }
      // A listener of the adoption may have ended the open.
      if (open === this.current && !complete) {
         void this.reread(open);
      }
   }

   /**
    * Note the epoch of a registration. After a reconnect, forget the number
    * of the write out: a conflict's reread waits for the reconnect, so the
    * batch is still out, and the restore that follows writes above the
    * refused number, which no document holds.
    */
   protected handleRegistered(event: DataSessionRegisterEvent): void {
      this.registeredEpoch = event.epoch;
      const open = this.current;
      if (!event.reconnected || open?.sendingWrite === undefined) {
         return;
      }
      const before = rootOrUndefined(() => this.root);
      open.sendingWrite = undefined;
      const after = rootOrUndefined(() => this.root);
      if (before !== after && (before === undefined || after === undefined || compare(before, after).length > 0)) {
         this.changeEmitter.fire({ reason: 'changed' });
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
      if (!open) {
         this.heardWhileLoading?.add(event.document.uri);
         return;
      }
      if (event.document.uri !== open.snapshot.uri) {
         return;
      }
      // An echo of the copy's own write is taken too: it holds the write, so
      // `root` no longer applies its edits. One from a server that reports no
      // writes is left while a write is out, since it may hold it.
      if (!reportsWrites(event.document) && open.sending.length > 0 && this.session.isOwnEcho(event.sourceClientId)) {
         return;
      }
      // An echo that holds the write out is announced with the write's answer,
      // which alone can tell it `written`. Announced now, a value the server
      // computes would show as `changed` first.
      const echo = this.session.isOwnEcho(event.sourceClientId) && this.holdsSending(open, event.document);
      this.offer(open, event.document, !echo);
   }

   /**
    * Take the dirty flag of a document the server sent, and the document
    * itself, unless it reports no writes and a request is out. A document
    * older than the snapshot is skipped.
    */
   protected offer(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>, announce: boolean): void {
      if (this.builtBefore(open, document)) {
         return;
      }
      const offered = document.model?.version;
      this.takeDirty(open, document.text);
      // Without `heldWrites`, it may hold a write out, which `root` would apply again.
      if (open.snapshotRequests > 0 && !reportsWrites(document)) {
         const held = open.held?.model?.version;
         if (held === undefined || offered === undefined || offered >= held) {
            this.hold(open, document);
         }
         return;
      }
      this.adopt(open, document, announce);
   }

   /**
    * Whether `document` was built before the snapshot of `open`. Versions rise
    * per server life, so only an older one of the same epoch was.
    */
   protected builtBefore(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>): boolean {
      const offered = document.model?.version;
      const current = open.snapshot.model?.version;
      return offered !== undefined && current !== undefined && offered < current && document.epoch === open.snapshot.epoch;
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

   /** Whether `document` holds the write out for {@link WorkingCopyOpen.sending}. */
   protected holdsSending(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>): boolean {
      const held = heldWriteOf(document, this.session.clientId);
      return open.sendingWrite !== undefined && held !== undefined && held >= open.sendingWrite;
   }

   /**
    * Take `document` as the new snapshot. Fires a change unless the model's
    * hash is the one held, which also means equally validated, or `announce`
    * is false, as for a write's answers and its own echo, which
    * {@link writeBatch} announces once the write's edits are off {@link root}.
    * While a write is out, it fires when {@link root} or {@link diagnostics}
    * changed instead.
    */
   protected adopt(open: WorkingCopyOpen<TTransfer>, document: TransferDocument<TTransfer>, announce = true): void {
      const held = open.snapshot.model?.hash;
      const changed = announce && (held === undefined || held !== document.model?.hash);
      // While a write is out, an echo can leave the root as it was, and a
      // document of an equal hash that holds the write can change it.
      const before =
         announce && open.sending.length > 0 ? { root: rootOrUndefined(() => this.root), diagnostics: [...this.diagnostics] } : undefined;
      open.snapshot = document;
      open.snapshotUnderWrite = open.sending.length > 0 && !reportsWrites(document);
      const after = before && { root: rootOrUndefined(() => this.root), diagnostics: [...this.diagnostics] };
      const comparable = before?.root !== undefined && after?.root !== undefined;
      if (comparable ? compare(before, after).length > 0 : changed) {
         this.changeEmitter.fire({ reason: 'changed' });
      }
   }

   /**
    * End a request, and take its answer unless it is older than the snapshot.
    * {@link dirty} is announced once the answer is taken.
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
   protected settleAnswer(open: WorkingCopyOpen<TTransfer>, received: TransferDocument<TTransfer> | undefined, announce: boolean): void {
      // A request sent before a restart can answer after it, for a server
      // whose document the restore replaced.
      const answer = received?.epoch === (this.registeredEpoch ?? open.snapshot.epoch) ? received : undefined;
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
