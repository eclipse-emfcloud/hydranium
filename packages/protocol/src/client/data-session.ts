/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable, Emitter, type Event } from 'vscode-jsonrpc';
import { type Clock, SystemClock } from '../clock';
import type { DataServerProtocol, DiagnosticOf, TransferDocumentDirtyChangedEvent, TransferDocumentUpdatedEvent } from '../data';
import { isConflictError, SessionClosedError } from '../errors';
import { type BasedOn, isSnapshotVersion, type SnapshotVersion } from '../model-service/based-on';
import { type ResolvedMessage, defineMessage, describeError, resolve } from '../messages/primitives';
import type { OpenModelArgs } from '../model-server';
import type { MaybePromise } from '../util';
import type { RpcProxy } from '../rpc';
import type { TransferDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';

/**
 * A session could not re-open a document it had open after its connection
 * dropped, and forgot it; or could not write it again for another reason than
 * a conflict, and keeps its unsaved edits for the next restore.
 */
export const DATA_SESSION_RESTORE_FAILED = defineMessage(
   'hydranium/protocol/data-session-restore-failed',
   'Could not restore {uri} after reconnecting to the data server: {detail}'
);

/**
 * A session re-opened documents after its connection dropped and cannot put
 * back what it wrote to them since their last save: another client changed
 * them, even while the session was still connected; the session could not
 * tell the text its writes started from, or lost another document written with
 * them; or the write it sent again conflicted. The session's unsaved edits may
 * be gone, and it no longer holds them.
 */
export const DATA_SESSION_UNSAVED_LOST = defineMessage(
   'hydranium/protocol/data-session-unsaved-lost',
   'Unsaved changes to {uris} may have been lost when the connection to the data server dropped.'
);

/**
 * What one of `TServer`'s document methods takes, minus the `clientId` a
 * {@link DataSession} stamps itself.
 *
 * Read off the SERVER's signature, not off the framework's own arg type: an
 * adopter server widens these, and a wrapper declared against the narrow
 * shape rejects the extra field on a fresh object literal, so that call
 * cannot go through a session at all.
 */
export type DataSessionArgs<TMethod extends (args: never) => unknown> = Omit<Parameters<TMethod>[0], 'clientId'>;

/**
 * Open a document through a session; the session supplies `clientId`. Only the
 * URI and the open's options: a session's open reads the file, and the server
 * ignores the `languageId`, `version` and `text` seeds of `OpenModelArgs`, so
 * accepting them here would let a caller believe they took effect.
 */
export type DataSessionOpenArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = Pick<OpenModelArgs, 'uri' | 'options'>;

/** Create a document through a session; the session supplies `clientId`. */
export type DataSessionCreateArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['createModelDocument']>;

/** Close a document through a session; the session supplies `clientId`. */
export type DataSessionCloseArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['closeModelDocument']>;

/** Update a document through a session; the session supplies `clientId`. */
export type DataSessionUpdateArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['updateModelDocument']>;

/** Update several documents at once through a session; the session supplies `clientId`. */
export type DataSessionUpdatesArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['updateModelDocuments']>;

/** Persist a document through a session; the session supplies `clientId`. */
export type DataSessionSaveArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['saveModelDocument']>;

/** The document a session hands back, carrying its server's diagnostic shape. */
export type DataSessionDocument<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = TransferDocument<TTransfer, DiagnosticOf<TServer>>;

/**
 * What a {@link DataSession} keeps of a URI it wrote since the URI's last save,
 * to write it again after a reconnect that lost it.
 */
export interface DataSessionUnsavedWrite<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> {
   /**
    * The {@link TransferDocument.textHash} of the text the first of these
    * writes was based on. `undefined` when the session could not tell, for a
    * write based on `'anything'` or on a version it could not read back, and
    * such a write is never sent again: the session cannot tell another
    * client's text from the text it wrote over.
    */
   readonly baseHash: string | undefined;
   readonly answer: Pick<DataSessionDocument<TTransfer, TServer>, 'version' | 'textHash'>;
   /**
    * The call that made the last write, and for an `updateDocuments` call this
    * URI's index in it. Records whose `updates` is the same object were
    * written together and are sent again together, so a restore never applies
    * part of a set.
    */
   readonly call:
      | { readonly update: DataSessionUpdateArgs<TTransfer, TServer> }
      | { readonly updates: DataSessionUpdatesArgs<TTransfer, TServer>; readonly index: number };
}

/** Where `write` stands in the `updateDocuments` call it was last written by; `0` for a single update. */
function indexOf(write: DataSessionUnsavedWrite<TransferElement, DataServerProtocol<TransferElement>>): number {
   return 'index' in write.call ? write.call.index : 0;
}

/**
 * What a {@link DataSession} needs from the connection that minted it.
 *
 * Narrower than the connection itself so the dependency points one way:
 * `DataConnection` constructs sessions, and nothing here imports it back.
 */
export interface DataSessionHost<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>>> {
   /** The connected, READY proxy of the current connection; a new object after each reconnect. */
   connected(): Promise<RpcProxy<TServer>>;
   /** Surface a failure no caller is waiting on, such as restoring a document after a reconnect. */
   reportError?(error: unknown, reported: ResolvedMessage): void;
   /**
    * Tell the connection's client the dirty state a restore read, unless it
    * is what the client was last told of the URI since the URI's last open.
    */
   restoreDirty?(event: TransferDocumentDirtyChangedEvent): void;
   /**
    * Forget what the client was told of `uri`'s dirty state: an open just
    * made answered its caller afresh, and the client heard none of it, or a
    * close leaves nothing to restore. Forgetting a URI another session still
    * has open costs at most one repeat of a state the client already has.
    */
   forgetDirty?(uri: string): void;
   /**
    * Fires with each flip of a document's dirty state the server sends. A
    * session drops the unsaved write it keeps of a document that turns
    * clean; without this event it keeps it, and a restore after another
    * client's save of the document can report the write lost.
    */
   readonly onDidChangeDirty?: Event<TransferDocumentDirtyChangedEvent>;
   /**
    * Fires with each update event the server sends. A session drops the
    * unsaved write it keeps of a document another client wrote over; without
    * this event it keeps it, and a restore reports the write lost.
    */
   readonly onDidUpdateDocument?: Event<TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>>;
}

/**
 * Builds the session `DataConnection.createSession` hands out, for an adopter
 * that extends {@link DataSession}. The connection has minted `clientId` and
 * checked it by then.
 */
export type DataSessionFactory<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>>> = (
   clientId: string,
   host: DataSessionHost<TTransfer, TServer>,
   label: string
) => DataSession<TTransfer, TServer>;

/**
 * One participant on a data connection: a properties panel, a tree, a form
 * editor. The client side of a server client session, registered over the
 * wire under {@link clientId}.
 *
 * The session writes only what it has open: the server refuses its update or
 * save of a document it has not opened with a `DocumentNotOpenError` code.
 * Every call waits for the registration, so the first can be issued at once.
 *
 * Every document operation stamps {@link clientId} itself. A caller that
 * passed its own could pass another participant's, and the server would
 * attribute the write and close the document accordingly.
 *
 * {@link closeDocument} and {@link dispose} first wait, up to
 * {@link settleBeforeCloseMs}, for this session's calls still in flight on the
 * URI, or on any URI for `dispose`: a save sent just before its close would
 * otherwise reach the server after it, and fail as not open.
 *
 * After the connection drops, the session registers again under the same id,
 * re-opens and re-watches what it had open, tells the client of their dirty
 * state where it changed, and reports the documents whose unsaved edits did
 * not survive; see {@link restore}. The connection does this at
 * once for a session with documents open, and any session's next call does it
 * too.
 *
 * Generic over the transfer root so this file names no grammar.
 *
 * `TServer` is bound to a server answering with ITS OWN diagnostic shape, read
 * back off the parameter being bound. Simplifying that to
 * `DataServerProtocol<TTransfer>` compiles and costs the wrappers their
 * return type: every call through `TServer` would resolve against that looser
 * bound, so an adopter's diagnostics would come back as the framework's and
 * the document would have to be cast on the way out.
 */
export class DataSession<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> implements Disposable {
   /**
    * How long {@link closeDocument} and {@link dispose} wait for this session's
    * calls in flight before closing anyway. Long, because the wait only runs
    * out when a call hangs, and a close sent while a save is still running
    * fails that save.
    */
   protected readonly settleBeforeCloseMs: number = 10_000;
   /**
    * The clock {@link settleBeforeCloseMs} runs on. {@link DataSessionHost}
    * carries no {@link Clock}, so a subclass replaces this field as it
    * replaces the bound.
    */
   protected readonly clock: Clock = new SystemClock();
   /** URIs this session has open, re-opened after a reconnect. */
   protected readonly openUris = new Set<string>();
   /**
    * Per URI in {@link openUris}, the URI the server's last answer to its open
    * or re-open named. The server keys its notifications by it, and so does
    * the host's record of what its client was told.
    */
   protected readonly serverUris = new Map<string, string>();
   /**
    * Per URI, how many opens of it this session has under way. Such a URI
    * counts as open for {@link withOpenDocument}, which would otherwise close
    * it under the open that is still being made.
    */
   protected readonly openingUris = new Map<string, number>();
   /** Per URI written since its last save, what {@link restore} needs to write it again. */
   protected readonly unsavedWrites = new Map<string, DataSessionUnsavedWrite<TTransfer, TServer>>();
   /**
    * Per URI this session has open, the version and text hash of the last
    * document one of its own calls was answered with, which spares the read a
    * first unsaved write otherwise makes for its base; see {@link baseHashOf}.
    */
   protected readonly lastAnswers = new Map<string, Pick<DataSessionDocument<TTransfer, TServer>, 'version' | 'textHash'>>();
   /**
    * Per URI this session has open, the version its last save of it was
    * answered with; see {@link recordWrite}. Only a save sets it: an open
    * answers at the version of a write still in flight as well, and that
    * write is not saved.
    */
   protected readonly savedVersions = new Map<string, SnapshotVersion>();
   /** Per URI, this session's calls still in flight on it, which a close waits for. */
   protected readonly inFlight = new Map<string, Set<Promise<unknown>>>();
   /** This session's saves still in flight, which a host's exit waits for; see {@link hasSavesInFlight}. */
   protected readonly savesInFlight = new Set<Promise<unknown>>();
   protected readonly disposeEmitter = new Emitter<void>();
   /**
    * Fires once when the session ends, by {@link dispose} or {@link detach}, as
    * soon as it rejects further calls and before any close is sent. For a
    * session its connection created, the connection's listener runs first, so
    * the id is free again on that connection by the time any other listener
    * runs; the server still holds it until the close arrives, and refuses a new
    * session under it until then.
    *
    * A listener subscribed once the session has ended is never called, so a
    * late subscriber checks {@link isDisposed} first.
    */
   readonly onDidDispose: Event<void> = this.disposeEmitter.event;
   /**
    * Sent with every registration, so the server lets this session register
    * its id again while the dropped connection's session is still live there:
    * a server that has not yet noticed the drop would otherwise refuse the id
    * as a duplicate until it does.
    */
   protected readonly resumeToken: string = globalThis.crypto.randomUUID();
   /** The proxy the session is registered on; another one means the connection was replaced. */
   protected registeredOn?: RpcProxy<TServer>;
   protected registration?: Promise<void>;
   protected disposed = false;
   /**
    * Disposed through {@link detach} rather than {@link dispose}, so nothing may
    * be sent. Folding it into {@link disposed} would send the session's close
    * over a connection that is going away.
    */
   protected detached = false;
   /** The subscription to the host's `onDidChangeDirty`, disposed with the session. */
   protected readonly dirtySubscription?: Disposable;
   /** The subscription to the host's `onDidUpdateDocument`, disposed with the session. */
   protected readonly updateSubscription?: Disposable;

   constructor(
      readonly clientId: string,
      protected readonly host: DataSessionHost<TTransfer, TServer>,
      readonly label: string
   ) {
      this.dirtySubscription = host.onDidChangeDirty?.(event => this.forgetSavedWrite(event));
      this.updateSubscription = host.onDidUpdateDocument?.(event => this.forgetSupersededWrite(event));
   }

   /**
    * The connected, READY server proxy once this session is registered on it,
    * for protocol methods this session does not wrap. The proxy stamps
    * nothing: pass this session's {@link clientId} to any method that carries
    * one.
    */
   async connected(): Promise<RpcProxy<TServer>> {
      // `async` so a disposed session REJECTS rather than throwing
      // synchronously: the connection's own `connected` rejects, and a caller
      // reaching for `.catch` on one of them would not catch the other.
      this.assertLive();
      const server = await this.host.connected();
      // Again after the wait: a session disposed meanwhile must not register,
      // since its dispose found nothing registered to end.
      this.assertLive();
      if (this.registeredOn !== server) {
         const reconnected = this.registeredOn !== undefined;
         this.registeredOn = server;
         this.registration = this.register(server, reconnected);
      }
      await this.registration;
      return server;
   }

   /**
    * Open `args.uri` for editing and start watching it, in that order,
    * returning the opened snapshot.
    *
    * **The order is the whole reason this method exists.**
    * `watchModelDocument` baselines its dedup fingerprint from the *current*
    * document, but only if one exists. Watching first therefore leaves no
    * baseline, and the first phase event after the open arrives as a spurious
    * `'changed'` — which a widget that resets its in-memory root to the server
    * view misreads as a concurrent third-party write, losing whatever the user
    * had typed.
    *
    * Note that the returned snapshot's empty `diagnostics` does not mean
    * valid: `open` settles at the integrity landmark, not at validation.
    * Validity arrives asynchronously on `onDocumentUpdated`, or synchronously
    * from `getModelDocument({ includeDiagnostics: true })`.
    */
   openDocument(args: DataSessionOpenArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.trackOpen(args.uri, async () => {
         const server = await this.connected();
         return this.watchOpened(server, args.uri, await server.openModelDocument({ ...args, clientId: this.clientId }));
      });
   }

   /**
    * Create a document that exists nowhere yet, open and watched for this
    * session; it reaches disk with the first {@link saveDocument}. The server
    * refuses a URI that exists on disk or that any client has open.
    */
   createDocument(args: DataSessionCreateArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.trackOpen(args.uri, async () => {
         const server = await this.connected();
         return this.watchOpened(server, args.uri, await server.createModelDocument({ ...args, clientId: this.clientId }));
      });
   }

   /**
    * Watch a document this session just opened, and record it as open. A
    * failed watch closes it again: the caller sees a failed open and so would
    * never close it.
    */
   protected async watchOpened(
      server: RpcProxy<TServer>,
      uri: string,
      document: DataSessionDocument<TTransfer, TServer>
   ): Promise<DataSessionDocument<TTransfer, TServer>> {
      try {
         await server.watchModelDocument({ uri, clientId: this.clientId });
      } catch (error: unknown) {
         await server.closeModelDocument({ uri, clientId: this.clientId }).catch(() => undefined);
         throw error;
      }
      this.openUris.add(uri);
      this.serverUris.set(uri, document.uri);
      this.lastAnswers.set(uri, { version: document.version, textHash: document.textHash });
      // Keyed as the server keys its notifications, which may not be how the
      // caller spelled the URI.
      this.host.forgetDirty?.(document.uri);
      return document;
   }

   /**
    * Close `args.uri`, once this session's calls on it have settled or
    * {@link settleBeforeCloseMs} has passed. The server unwatches implicitly,
    * so this is the dual of {@link openDocument} and needs no separate unwatch.
    */
   async closeDocument(args: DataSessionCloseArgs<TTransfer, TServer>): Promise<void> {
      this.assertLive();
      await this.settle(this.inFlight.get(args.uri));
      // Forgotten before the close is sent, so a reconnect in between does not
      // re-open a document the caller has closed; after the wait, so an open
      // of it that was still in flight does not record it again.
      const serverUri = this.serverUris.get(args.uri) ?? args.uri;
      this.openUris.delete(args.uri);
      this.serverUris.delete(args.uri);
      this.unsavedWrites.delete(args.uri);
      this.lastAnswers.delete(args.uri);
      this.savedVersions.delete(args.uri);
      this.host.forgetDirty?.(serverUri);
      const server = await this.connected();
      await server.closeModelDocument({ ...args, clientId: this.clientId });
   }

   /**
    * Open `args.uri`, run `fn` with the opened snapshot, and close it once
    * `fn` settles, whether it returned or threw. A URI this session already
    * had open, or is still opening through another call, stays open: the close
    * undoes only the open this call made.
    */
   async withOpenDocument<T>(
      args: DataSessionOpenArgs<TTransfer, TServer>,
      fn: (document: DataSessionDocument<TTransfer, TServer>) => MaybePromise<T>
   ): Promise<T> {
      const alreadyOpen = this.openUris.has(args.uri) || this.openingUris.has(args.uri);
      const document = await this.openDocument(args);
      try {
         return await fn(document);
      } finally {
         if (!alreadyOpen && !this.disposed) {
            await this.closeDocument({ uri: args.uri } as DataSessionCloseArgs<TTransfer, TServer>);
         }
      }
   }

   /** Write `args.model` back as this session. The session must have `args.uri` open. */
   updateDocument(args: DataSessionUpdateArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.track([args.uri], async () => {
         const server = await this.connected();
         const update = { ...args };
         const baseHash = await this.baseHashOf(server, args.uri, args.basedOn);
         const document = await server.updateModelDocument({ ...args, clientId: this.clientId });
         this.recordWrite(args.uri, document, baseHash, { update });
         return document;
      });
   }

   /**
    * Write several documents this session has open, all or none: the server
    * refuses the whole set, before any text applies, when one is stale or not
    * open. Resolves to the documents in the order given.
    */
   updateDocuments(args: DataSessionUpdatesArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>[]> {
      return this.track(
         args.updates.map(update => update.uri),
         async () => {
            // One copy for the whole call: the copy's identity is what ties its
            // records together.
            const updates = { ...args, updates: args.updates.map(update => ({ ...update })) };
            const server = await this.connected();
            const baseHashes = await Promise.all(args.updates.map(update => this.baseHashOf(server, update.uri, update.basedOn)));
            const documents = await server.updateModelDocuments({ ...args, clientId: this.clientId });
            args.updates.forEach((update, index) => this.recordWrite(update.uri, documents[index], baseHashes[index], { updates, index }));
            return documents;
         }
      );
   }

   /** Persist `args.model` to disk as this session. The session must have `args.uri` open. */
   saveDocument(args: DataSessionSaveArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      const saving = this.track([args.uri], async () => {
         const server = await this.connected();
         const unsaved = this.unsavedWrites.get(args.uri);
         const document = await server.saveModelDocument({ ...args, clientId: this.clientId });
         // A write that answered while the save ran made a record the save
         // may not have persisted, which a restore still needs.
         if (this.unsavedWrites.get(args.uri) === unsaved) {
            this.unsavedWrites.delete(args.uri);
         }
         this.lastAnswers.set(args.uri, { version: document.version, textHash: document.textHash });
         // The higher of two saves' answers, which may arrive out of order.
         const saved = this.savedVersions.get(args.uri);
         if (saved === undefined || document.version > saved) {
            this.savedVersions.set(args.uri, document.version);
         }
         return document;
      });
      this.savesInFlight.add(saving);
      const done = (): boolean => this.savesInFlight.delete(saving);
      saving.then(done, done);
      return saving;
   }

   /** Whether the session has ended, by {@link dispose} or {@link detach}. */
   get isDisposed(): boolean {
      return this.disposed;
   }

   /**
    * Whether a save of this session has not answered yet. Synchronous, for a
    * host whose exit veto must decide within the tick, such as Theia's
    * `onWillStop`.
    */
   get hasSavesInFlight(): boolean {
      return this.savesInFlight.size > 0;
   }

   /**
    * Resolves once the saves in flight now have answered, or
    * {@link settleBeforeCloseMs} has passed. Never rejects: a failed save has
    * answered too.
    */
   whenSavesSettled(): Promise<void> {
      return this.settle(this.savesInFlight);
   }

   /**
    * Whether `sourceClientId` identifies this session's own write.
    *
    * Every watcher needs this and the check is one comparison, so getting it
    * wrong is cheap to do and expensive to find: an unfiltered echo looks
    * exactly like a concurrent third-party edit.
    */
   isOwnEcho(sourceClientId: string): boolean {
      return sourceClientId === this.clientId;
   }

   /**
    * End the session: detach it from the connection at once, and once its
    * calls in flight have settled or {@link settleBeforeCloseMs} has passed,
    * end it on the server, which closes everything it has open. Idempotent,
    * and leaves the connection usable by its other sessions.
    *
    * Every later call rejects, and so does a call made earlier in the same
    * tick, which has not reached the wire yet and is never sent. The server
    * close is not awaited, because a `Disposable` cannot be; a close that fails
    * leaves the session to the server's connection-close cleanup.
    */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.fireDispose();
      const pending = [...this.inFlight.values()].flatMap(calls => [...calls]);
      void (async () => {
         await this.settle(pending);
         await this.registration;
         // The proxy the session registered on, never a fresh connection: a
         // connection that dropped already ended the session on the server.
         if (!this.detached && this.registeredOn) {
            await this.registeredOn.closeSession({ clientId: this.clientId });
         }
      })().catch(() => undefined);
   }

   /**
    * Come off the connection because it is going away.
    *
    * Sends nothing, unlike {@link dispose}: the server ends every session on a
    * connection it sees close, and the close would travel over the very
    * connection being disposed.
    *
    * Public because the connection calls it; anyone else ends a session with
    * {@link dispose}. It fires {@link onDidDispose} only if the session has not
    * already ended, and after {@link dispose} it still cancels the close that
    * dispose has not sent yet.
    */
   detach(): void {
      this.detached = true;
      this.openUris.clear();
      this.serverUris.clear();
      this.unsavedWrites.clear();
      this.lastAnswers.clear();
      this.savedVersions.clear();
      if (!this.disposed) {
         this.disposed = true;
         this.fireDispose();
      }
   }

   /**
    * Dispose {@link dirtySubscription} and {@link updateSubscription}, fire
    * {@link onDidDispose} and dispose its emitter, so a second call fires
    * nothing.
    */
   protected fireDispose(): void {
      this.dirtySubscription?.dispose();
      this.updateSubscription?.dispose();
      this.disposeEmitter.fire(undefined);
      this.disposeEmitter.dispose();
   }

   /**
    * Register again and restore now, after the connection dropped, instead of
    * on the next call. A no-op for a session with nothing open, which the next
    * call restores anyway. A failure is left to that next call, which meets it
    * again.
    */
   reconnect(): void {
      if (!this.disposed && this.openUris.size > 0) {
         this.connected().catch(() => undefined);
      }
   }

   /**
    * Drop the record in {@link unsavedWrites} of a document this session has
    * open once the server says it turned clean: it holds no unsaved text
    * then, and a record kept would have a restore report the write lost once
    * another client's save changed the file.
    *
    * The server sends a flip only for a document someone watches, so a
    * document the session writes without watching it keeps its record, and
    * can still be reported lost that way.
    */
   protected forgetSavedWrite(event: TransferDocumentDirtyChangedEvent): void {
      if (event.dirty) {
         return;
      }
      // The flip names the server's key, which is not always the caller's
      // spelling that the records are kept under.
      for (const [uri, serverUri] of this.serverUris) {
         if (serverUri === event.uri) {
            this.unsavedWrites.delete(uri);
         }
      }
   }

   /**
    * Drop the record in {@link unsavedWrites} of a document another client
    * wrote over while the connection held: its write replaced the session's,
    * so a restore has nothing of the session's to put back, and a record kept
    * would have it report the write lost to the reconnect. A write superseded
    * before its answer needs nothing: the answer names the other client's
    * text, which the record then holds.
    *
    * Only a `'changed'` event from another client counts, and only where the
    * document no longer holds the write: the session's own echo, and an
    * integrity repair already in the write's answer, replaced nothing, and a
    * `'rebuilt'` event carries no new text. Like {@link forgetSavedWrite}, it
    * depends on the server sending the event, which it does only for a
    * document someone watches.
    */
   protected forgetSupersededWrite(event: TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>): void {
      if (event.reason !== 'changed' || this.isOwnEcho(event.sourceClientId)) {
         return;
      }
      for (const [uri, serverUri] of this.serverUris) {
         const write = this.unsavedWrites.get(uri);
         if (serverUri === event.document.uri && write && this.restoreOutcome(write, event.document) !== 'kept') {
            this.unsavedWrites.delete(uri);
         }
      }
   }

   /**
    * Register on `server`, and after a reconnect restore what the ended session
    * had. Calls issued meanwhile wait for this.
    */
   protected async register(server: RpcProxy<TServer>, reconnected: boolean): Promise<void> {
      await server.createSession({ clientId: this.clientId, label: this.label, resumeToken: this.resumeToken });
      if (reconnected) {
         await this.restore(server);
      }
   }

   /**
    * Re-open and re-watch every document the session had open, write again
    * what it wrote since their last save where the re-open lost it, and tell
    * the host which of them lost it for good.
    *
    * Decided per document by the re-opened {@link TransferDocument.textHash},
    * in {@link restoreOutcome}. Versions cannot decide a write: a revert moves
    * the version on and a restarted server numbers afresh, so the version the
    * last write was answered with never matches where a write is needed, and
    * any other version may be another client's edit, which a write would
    * overwrite.
    *
    * Only what the drop cost is reported: a write another client wrote over
    * while the connection held has no record left by then, see
    * {@link forgetSupersededWrite}.
    *
    * A write is sent again based on the re-opened version, as an ordinary
    * write, so an edit arriving in between conflicts, and a conflict is not
    * retried. Documents last written by one {@link updateDocuments} are sent
    * again by one, and only when every one of them may be; a document that
    * could not be re-opened blocks its set.
    *
    * No caller is waiting, so the outcomes go through the host: one report
    * naming every document whose unsaved text is gone, whose record is then
    * dropped, and one per document that could not be re-opened or written
    * again for another reason than a conflict. A document that could not be
    * re-opened is forgotten; a failed write keeps its record, for the next
    * restore to decide again.
    *
    * Each document's dirty state goes to the host too, read once the watch is
    * in place and any write is sent: a flip while the connection was down, or
    * between the re-open and the watch, reached no one, and the re-open's own
    * answer misses the second. Read before the write, it would tell the client
    * a document is clean that the write is about to make dirty again.
    */
   protected async restore(server: RpcProxy<TServer>): Promise<void> {
      const writes = [...this.unsavedWrites];
      // No write sent before the drop answers any more, and a restarted
      // server numbers afresh, below the versions saved before it.
      this.savedVersions.clear();
      const reopened = new Map<string, DataSessionDocument<TTransfer, TServer>>();
      for (const uri of [...this.openUris]) {
         try {
            const document = await server.openModelDocument({ uri, clientId: this.clientId });
            await server.watchModelDocument({ uri, clientId: this.clientId });
            if (this.openUris.has(uri)) {
               this.serverUris.set(uri, document.uri);
               this.lastAnswers.set(uri, { version: document.version, textHash: document.textHash });
            }
            reopened.set(uri, document);
         } catch (error: unknown) {
            // Its record goes with its set's, in `reapply`, which it blocks.
            this.openUris.delete(uri);
            this.serverUris.delete(uri);
            this.lastAnswers.delete(uri);
            this.savedVersions.delete(uri);
            this.host.reportError?.(error, resolve(DATA_SESSION_RESTORE_FAILED, { uri, detail: describeError(error) }));
         }
      }
      const sets = new Map<object, [string, DataSessionUnsavedWrite<TTransfer, TServer>][]>();
      for (const [uri, write] of writes) {
         const call = 'update' in write.call ? write.call.update : write.call.updates;
         sets.set(call, [...(sets.get(call) ?? []), [uri, write]]);
      }
      const lost: string[] = [];
      for (const members of sets.values()) {
         lost.push(...(await this.reapply(server, members, reopened)));
      }
      for (const uri of reopened.keys()) {
         if (!this.openUris.has(uri)) {
            continue;
         }
         // A failed read leaves the client's dirty state as it was; the
         // document is restored all the same.
         const current = await server.getModelDocument({ uri }).catch(() => undefined);
         if (current?.dirty !== undefined) {
            try {
               this.host.restoreDirty?.({ uri: current.uri, dirty: current.dirty });
            } catch {
               // The client's listener failed, not the restore: the server
               // has the document open and watched, so it stays restored.
            }
         }
      }
      if (lost.length > 0) {
         const reported = resolve(DATA_SESSION_UNSAVED_LOST, { uris: lost.join(', ') });
         this.host.reportError?.(new Error(reported.text), reported);
      }
   }

   /**
    * Whether the re-opened `document` still holds the session's unsaved
    * `write` (`'kept'`), holds the text the write started from, so the write
    * can be sent again (`'resend'`), or holds something else (`'lost'`).
    *
    * A document without a text hash comes from a server that sends none, and
    * counts as kept only at the version the write was answered with.
    */
   protected restoreOutcome(
      write: DataSessionUnsavedWrite<TTransfer, TServer>,
      document: DataSessionDocument<TTransfer, TServer>
   ): 'kept' | 'resend' | 'lost' {
      if (document.textHash === undefined) {
         return document.version === write.answer.version ? 'kept' : 'lost';
      }
      if (document.textHash === write.answer.textHash) {
         return 'kept';
      }
      return write.baseHash !== undefined && document.textHash === write.baseHash ? 'resend' : 'lost';
   }

   /**
    * Write again, in one call and based on their `reopened` versions, the
    * `members` of one write call that the re-open lost, all or none. Returns
    * the URIs whose unsaved text is gone, and drops their records, and the
    * record of a member that could not be re-opened.
    *
    * A member whose record is no longer the one the restore started with was
    * closed, saved or disposed meanwhile, and is left out: writing it would
    * put back text its caller discarded.
    */
   protected async reapply(
      server: RpcProxy<TServer>,
      members: readonly [string, DataSessionUnsavedWrite<TTransfer, TServer>][],
      reopened: ReadonlyMap<string, DataSessionDocument<TTransfer, TServer>>
   ): Promise<string[]> {
      const current = (uri: string, write: DataSessionUnsavedWrite<TTransfer, TServer>): boolean =>
         !this.disposed && this.unsavedWrites.get(uri) === write;
      const outcomes = members
         .filter(([uri, write]) => current(uri, write))
         .map(([uri, write]) => {
            const document = reopened.get(uri);
            return { uri, write, document, outcome: document ? this.restoreOutcome(write, document) : 'failed' };
         });
      // A restarted server numbers afresh: the answers to later writes follow
      // on from the re-opened version, not from the one the record holds.
      for (const { uri, write, document, outcome } of outcomes) {
         if (outcome === 'kept' && document) {
            this.unsavedWrites.set(uri, { ...write, answer: { version: document.version, textHash: document.textHash } });
         }
      }
      // A document that could not be re-opened is forgotten, and was reported
      // as such.
      const lose = (): string[] => {
         outcomes.filter(member => member.outcome !== 'kept').forEach(member => this.unsavedWrites.delete(member.uri));
         return outcomes.filter(member => member.outcome === 'lost' || member.outcome === 'resend').map(member => member.uri);
      };
      if (outcomes.some(member => member.outcome === 'lost' || member.outcome === 'failed')) {
         return lose();
      }
      // In the order of the call's updates, which is the order of its answers.
      const resend = outcomes
         .flatMap(({ uri, write, document, outcome }) =>
            outcome === 'resend' && document ? [{ uri, write, basedOn: document.version }] : []
         )
         .sort((left, right) => indexOf(left.write) - indexOf(right.write));
      if (resend.length === 0) {
         return [];
      }
      let documents: DataSessionDocument<TTransfer, TServer>[];
      try {
         const { call } = resend[0].write;
         if ('update' in call) {
            documents = [await server.updateModelDocument({ ...call.update, basedOn: resend[0].basedOn, clientId: this.clientId })];
         } else {
            const basedOn = new Map(resend.map(member => [indexOf(member.write), member.basedOn]));
            documents = await server.updateModelDocuments({
               ...call.updates,
               clientId: this.clientId,
               updates: call.updates.updates.flatMap((update, index) => {
                  const version = basedOn.get(index);
                  return version === undefined ? [] : [{ ...update, basedOn: version }];
               })
            });
         }
      } catch (error: unknown) {
         if (isConflictError(error)) {
            return lose();
         }
         for (const { uri, write, basedOn } of resend) {
            this.host.reportError?.(error, resolve(DATA_SESSION_RESTORE_FAILED, { uri, detail: describeError(error) }));
            // Kept for the next restore, and numbered from the re-opened
            // version, as the kept records are: a record numbered by a server
            // that has since restarted would have later answers ignored.
            if (current(uri, write)) {
               this.unsavedWrites.set(uri, { ...write, answer: { ...write.answer, version: basedOn } });
            }
         }
         return [];
      }
      resend.forEach((member, index) => {
         if (current(member.uri, member.write)) {
            // Recorded afresh, since the answer of a restarted server may be
            // numbered below the one it replaces.
            this.unsavedWrites.delete(member.uri);
            this.recordWrite(member.uri, documents[index], member.write.baseHash, member.write.call);
         }
      });
      return [];
   }

   /**
    * The text hash of the version `basedOn` names for `uri`, for a write that
    * starts the URI's record in {@link unsavedWrites}; `undefined` for any
    * other write, whose record keeps the base it has.
    *
    * Taken from {@link lastAnswers} when that is at the version, otherwise
    * read, and kept only when the read answers that version: a server's text
    * changes only with its version, so the text at a version is the text the
    * write, once it passes the gate, was applied to.
    */
   protected async baseHashOf(server: RpcProxy<TServer>, uri: string, basedOn: BasedOn): Promise<string | undefined> {
      if (this.unsavedWrites.has(uri) || !isSnapshotVersion(basedOn)) {
         return undefined;
      }
      const known = this.lastAnswers.get(uri);
      if (known?.version === basedOn) {
         return known.textHash;
      }
      const read = await server.getModelDocument({ uri }).catch(() => undefined);
      return read?.version === basedOn ? read.textHash : undefined;
   }

   /**
    * Record `document` as the answer to a write of `uri`, keeping the base of
    * the URI's record if it has one. An answer numbered below the record's is
    * ignored: two writes of `uri` in flight at once may answer out of order,
    * and the record holds the one applied last.
    *
    * So is one numbered at or below the URI's entry in {@link savedVersions}.
    * The save came after that write was applied, so the save persisted its
    * text or a later write replaced it, and its answer carries the text as it
    * was when sent, which a restore would report as lost.
    */
   protected recordWrite(
      uri: string,
      document: DataSessionDocument<TTransfer, TServer>,
      baseHash: string | undefined,
      call: DataSessionUnsavedWrite<TTransfer, TServer>['call']
   ): void {
      const answer = { version: document.version, textHash: document.textHash };
      const kept = this.unsavedWrites.get(uri);
      if (kept && answer.version < kept.answer.version) {
         return;
      }
      const saved = this.savedVersions.get(uri);
      if (saved !== undefined && answer.version <= saved) {
         return;
      }
      this.unsavedWrites.set(uri, { baseHash: kept ? kept.baseHash : baseHash, answer, call });
      this.lastAnswers.set(uri, answer);
   }

   /** Run `call`, counted as in flight on each of `uris` until it settles. */
   protected track<T>(uris: readonly string[], call: () => Promise<T>): Promise<T> {
      const running = call();
      for (const uri of uris) {
         this.inFlight.set(uri, (this.inFlight.get(uri) ?? new Set<Promise<unknown>>()).add(running));
      }
      const done = (): void => uris.forEach(uri => this.inFlight.get(uri)?.delete(running));
      running.then(done, done);
      return running;
   }

   /** {@link track} an open of `uri`, counted in {@link openingUris} until it settles. */
   protected trackOpen<T>(uri: string, call: () => Promise<T>): Promise<T> {
      this.openingUris.set(uri, (this.openingUris.get(uri) ?? 0) + 1);
      const done = (): void => {
         const remaining = (this.openingUris.get(uri) ?? 1) - 1;
         if (remaining > 0) {
            this.openingUris.set(uri, remaining);
         } else {
            this.openingUris.delete(uri);
         }
      };
      const running = this.track([uri], call);
      running.then(done, done);
      return running;
   }

   /** Wait until `calls` have settled, or {@link settleBeforeCloseMs} has passed. */
   protected async settle(calls: Iterable<Promise<unknown>> | undefined): Promise<void> {
      const pending = [...(calls ?? [])];
      if (pending.length === 0) {
         return;
      }
      await this.clock.raceTimer(Promise.allSettled(pending), this.settleBeforeCloseMs);
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new SessionClosedError(this.clientId);
      }
   }
}
