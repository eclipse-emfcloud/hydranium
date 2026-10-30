/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable, Emitter, type Event } from 'vscode-jsonrpc';
import { UNKNOWN_CLIENT_ID } from '../client-ids';
import { type Clock, SystemClock, TIMED_OUT } from '../clock';
import type {
   DataServerProtocol,
   DiagnosticOf,
   TransferDocumentDeletedEvent,
   TransferDocumentDirtyChangedEvent,
   TransferDocumentUpdatedEvent
} from '../data';
import { isConflictError, SessionClosedError } from '../errors';
import type { Logger } from '../logger';
import { type BaseVersion, isModelVersion, type ModelVersion, type TextVersion, UNRECORDED_VERSION } from '../model-service/base-version';
import { type ResolvedMessage, defineMessage, describeError, resolve } from '../messages/primitives';
import { NoopLogger } from '../noop-logger';
import { PendingWorkTracker } from '../pending-work-tracker';
import { randomUuid } from '../random-uuid';
import type { MaybePromise } from '../util';
import type { RpcProxy } from '../rpc';
import type { TextState, TransferCreatedDocument, TransferDocument, TransferSavedDocument } from '../transfer-document';
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

/** A write or open of `{uri}` that the data server answered without a model. */
export const DATA_SESSION_ANSWER_WITHOUT_MODEL = defineMessage(
   'hydranium/protocol/data-session-answer-without-model',
   'The data server answered a write of {uri} without a model; the session counts that answer as older than every version.'
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
 * URI and the open's options, read off the server's signature: the server
 * ignores the `languageId`, `version` and `text` seeds of `OpenModelArgs`, and
 * a field an adopter adds never reaches the server session's open, so
 * accepting either would let a caller believe it took effect.
 */
export type DataSessionOpenArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = Pick<Parameters<TServer['openModelDocument']>[0], 'uri' | ('options' & keyof Parameters<TServer['openModelDocument']>[0])>;

/**
 * The options an open through a session passes to `TServer`, `undefined` when
 * it passed none; only `undefined` for a server whose open takes none.
 */
export type DataSessionOpenOptions<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionOpenArgs<TTransfer, TServer>['options' & keyof DataSessionOpenArgs<TTransfer, TServer>] | undefined;

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

/** Persist the text the server holds through a session; the session supplies `clientId`. */
export type DataSessionPersistArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['persistModelDocument']>;

/** Delete a document through a session; the session supplies `clientId`. */
export type DataSessionDeleteArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = DataSessionArgs<TServer['deleteModelDocument']>;

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
    * The `text.hash` of the text the first of these writes was based on.
    * `undefined` when the session could not tell, for a write based on
    * `'any'` or on a version it could not read back, and such a write is
    * never sent again: the session cannot tell another client's text from the
    * text it wrote over.
    */
   readonly baseHash: string | undefined;
   /**
    * The model version the last of these writes was answered with, which
    * orders its answers, and the `text.hash` of that answer.
    */
   readonly answer: { readonly version: ModelVersion; readonly hash?: string };
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

/**
 * One open of a URI by a {@link DataSession}, from the answer to its open,
 * create or re-open until a close or a deletion ends it. A call records its
 * answer only while the open it was sent under is still the URI's: checking
 * that the URI is open accepts an answer from before a close or deletion
 * once the URI is open again.
 */
export interface DataSessionOpen<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> {
   /** The URI the open's answer named, which the server keys its notifications by. */
   readonly serverUri: string;
   /**
    * The options the server opened under, which a re-open after a reconnect
    * passes again: those of the earliest open of the URI under way when the
    * first answered, since the server keeps the open that arrives first.
    */
   readonly options: DataSessionOpenOptions<TTransfer, TServer>;
   /** Whether a deletion ended the open, which an open still watching sends again; a close does not. */
   deleted: boolean;
}

/**
 * One open or create of a URI by a {@link DataSession}, from its call until it
 * settles. A close of the URI while it is under way marks it: it then records
 * nothing and is not sent again, so the close stands. Without the mark, a
 * deletion during its watch has it sent again after the close.
 */
export interface DataSessionOpening<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> {
   /** Whether a close of the URI came while this open was under way. */
   closed: boolean;
   /** The options the open was sent with; none for a create. */
   readonly options: DataSessionOpenOptions<TTransfer, TServer>;
}

/** Where `write` stands in the `updateDocuments` call it was last written by; `0` for a single update. */
function indexOf(write: DataSessionUnsavedWrite<TransferElement, DataServerProtocol<TransferElement>>): number {
   return 'index' in write.call ? write.call.index : 0;
}

/** The call `write` was last written by, which a restore writes again as one set. */
function setOf(write: DataSessionUnsavedWrite<TransferElement, DataServerProtocol<TransferElement>>): object {
   return 'update' in write.call ? write.call.update : write.call.updates;
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
    * Tell the connection's client of a document a restore found gone, whose
    * deletion reached no one while the connection was down, as the server
    * tells it of a deletion over a live connection. Without it, the restore
    * reports the unsaved text such a document took with it as lost.
    */
   restoreDeletion?(event: TransferDocumentDeletedEvent): void;
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
   /**
    * Fires with each deletion the server sends. A session forgets a document
    * whose file was deleted; without this event it keeps it as open until a
    * restore finds it gone.
    */
   readonly onDidDeleteDocument?: Event<TransferDocumentDeletedEvent>;
   /** Where the session logs the documents it forgets as gone. */
   readonly logger?: Logger;
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
 * {@link closeDocument}, {@link deleteDocument} and {@link dispose} first wait,
 * up to {@link settleBeforeCloseMs}, for this session's calls still in flight
 * on the URI, or on any URI for `dispose`: a save sent just before its close
 * would otherwise reach the server after it, and fail as not open. An open or
 * create of a URI called while a close or delete of it is under way is sent
 * once that has answered, so the server takes them in the order they were
 * called.
 *
 * After the connection drops, the session registers again under the same id,
 * re-opens and re-watches what it had open, tells the client of their dirty
 * state where it changed, and reports the documents whose unsaved edits did
 * not survive; see {@link restore}. The connection does this at
 * once for a session with documents open, and again once any later connection
 * is ready, so a reconnect that failed is not left to the session's own next
 * call; any session's next call does it too.
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
    * How long {@link closeDocument}, {@link deleteDocument} and {@link dispose}
    * wait for this session's calls in flight before going on anyway. Long,
    * because a close sent while a save is still writing fails that save. It
    * need not outlast the server's language-client settle after the write,
    * which a close does not fail.
    */
   protected readonly settleBeforeCloseMs: number = 10_000;
   /**
    * How long {@link whenWritesSettled} waits before going on anyway: well past
    * the server's bound on the language-client settle it runs before answering
    * an update. The update itself has no bound, so a server slower than that is
    * taken as lost.
    */
   protected readonly settleWritesMs: number = 30_000;
   /**
    * The clock {@link settleBeforeCloseMs} runs on. {@link DataSessionHost}
    * carries no {@link Clock}, so a subclass replaces this field as it
    * replaces the bound.
    */
   protected readonly clock: Clock = new SystemClock();
   /** URIs this session has open, re-opened after a reconnect. */
   protected readonly openUris = new Set<string>();
   /**
    * Per URI in {@link openUris}, or whose open answered and whose watch is
    * still under way, the open it is under. A repeat open keeps it, as the
    * server keeps its earlier open.
    */
   protected readonly opens = new Map<string, DataSessionOpen<TTransfer, TServer>>();
   /**
    * Per URI, the opens of it this session has under way. Such a URI counts
    * as open for {@link withOpenDocument}, which would otherwise close it
    * under the open that is still being made.
    */
   protected readonly openings = new Map<string, Set<DataSessionOpening<TTransfer, TServer>>>();
   /**
    * Per URI, the closes and deletes of it this session has under way, which
    * an open or create called meanwhile waits for; see {@link trackEnding}.
    */
   protected readonly endings = new Map<string, Promise<unknown>>();
   /** Per URI written since its last save, what {@link restore} needs to write it again. */
   protected readonly unsavedWrites = new Map<string, DataSessionUnsavedWrite<TTransfer, TServer>>();
   /**
    * Per URI this session has open, the text of the last document one of its
    * own calls was answered with, which spares the read a first unsaved write
    * otherwise makes for its base; see {@link baseHashOf}.
    */
   protected readonly lastAnswers = new Map<string, TextState>();
   /**
    * Per URI this session has open, the text version its last save or persist
    * of it wrote, as its answer's `persisted` says; see {@link recordWrite}.
    * Not the answer's model version, which can carry a write that landed
    * after the text was taken. Only those set it: an open answers at the
    * version of a write still in flight as well, and that write is not saved.
    */
   protected readonly savedVersions = new Map<string, TextVersion>();
   /**
    * URIs this session created whose whole text is still its own and unsaved,
    * even with no write recorded: no save, clean flip, other client's write or
    * reported loss has come since the create, its answer included; see
    * {@link forgetGoneDocument}.
    */
   protected readonly createdUris = new Set<string>();
   /** Per URI, this session's calls still in flight on it, which a close or delete waits for. */
   protected readonly inFlight = new Map<string, PendingWorkTracker>();
   /** This session's saves, persists and deletes still in flight, which a host's exit waits for; see {@link hasSavesInFlight}. */
   protected readonly savesInFlight = new PendingWorkTracker();
   /** This session's updates still in flight, which a page's unload guard and save account for; see {@link hasWritesInFlight}. */
   protected readonly writesInFlight = new PendingWorkTracker();
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
   protected readonly resumeToken: string = randomUuid();
   /** The proxy the session is registered on; another one means the connection was replaced. */
   protected registeredOn?: RpcProxy<TServer>;
   /** The registration on {@link registeredOn}, which {@link connected} awaits. Replaced when the proxy changes. */
   protected registration?: Promise<void>;
   /** Set by {@link dispose} or {@link detach}, whichever comes first, after which {@link assertLive} throws. */
   protected disposed = false;
   /**
    * Disposed through {@link detach} rather than {@link dispose}, so nothing may
    * be sent. Folding it into {@link disposed} would send the session's close
    * over a connection that is going away.
    */
   protected detached = false;
   /**
    * Write sets, keyed as a restore groups them, that lost a document to
    * another client's deletion. A restore cannot write such a set again
    * whole, so it writes none of it. Weak, so a set goes once no write
    * record holds it.
    */
   protected readonly brokenSets = new WeakSet<object>();
   /** The subscription to the host's `onDidChangeDirty`, disposed with the session. */
   protected readonly dirtySubscription?: Disposable;
   /** The subscription to the host's `onDidUpdateDocument`, disposed with the session. */
   protected readonly updateSubscription?: Disposable;
   /** The subscription to the host's `onDidDeleteDocument`, disposed with the session. */
   protected readonly deletionSubscription?: Disposable;
   /** The host's logger, or one that logs nothing. */
   protected readonly logger: Logger;

   constructor(
      readonly clientId: string,
      protected readonly host: DataSessionHost<TTransfer, TServer>,
      readonly label: string
   ) {
      this.logger = host.logger ?? new NoopLogger();
      this.dirtySubscription = host.onDidChangeDirty?.(event => this.forgetSavedWrite(event));
      this.updateSubscription = host.onDidUpdateDocument?.(event => this.forgetSupersededWrite(event));
      this.deletionSubscription = host.onDidDeleteDocument?.(event => this.forgetDeletedDocument(event));
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
      // And after the registration: a call waiting on it has not reached the
      // wire, and sent now it would land after the session's close.
      this.assertLive();
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
    * Note that the returned snapshot's model usually has no `diagnostics`:
    * `open` settles at the integrity landmark, not at validation.
    * Validity arrives asynchronously on `onDocumentUpdated`, or synchronously
    * from `getModelDocument({ includeDiagnostics: true })`.
    */
   openDocument(args: DataSessionOpenArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.trackOpen(args.uri, args.options, opening =>
         this.openAndWatch(
            args.uri,
            opening,
            () => undefined,
            server => server.openModelDocument({ ...args, clientId: this.clientId })
         )
      );
   }

   /**
    * Create a document that exists nowhere yet, open and watched for this
    * session; it reaches disk with the first {@link saveDocument}. The server
    * refuses a URI that exists on disk or that any client has open. The answer
    * names the version the create made in `created`, which a write of what
    * this session created is based on: the answered model can already be
    * another client's write or an integrity repair.
    */
   createDocument(args: DataSessionCreateArgs<TTransfer, TServer>): Promise<TransferCreatedDocument<TTransfer, DiagnosticOf<TServer>>> {
      return this.trackOpen(args.uri, undefined, opening =>
         this.openAndWatch(
            args.uri,
            opening,
            document => document.created.version,
            server => server.createModelDocument({ ...args, clientId: this.clientId })
         )
      );
   }

   /**
    * Send `open` and watch what it answered, again for as long as a deletion
    * heard while the watch is under way closes that open: sent after the
    * deletion, the open fails as an open of a gone file does, or opens the
    * file that is back. `created` reads the version the create made off the
    * answered document, or none for an open; see {@link watchOpened} for the
    * mark it puts in {@link createdUris}.
    *
    * An `opening` a close marked answers with the document, recording nothing
    * and sending nothing again; one it marked before the open answered is
    * undone, since the server may have taken the close first. A failed watch
    * is undone too: the caller sees a failed open, and so would never close it.
    */
   protected async openAndWatch<TDocument extends DataSessionDocument<TTransfer, TServer>>(
      uri: string,
      opening: DataSessionOpening<TTransfer, TServer>,
      created: (document: TDocument) => ModelVersion | undefined,
      open: (server: RpcProxy<TServer>) => Promise<TDocument>
   ): Promise<TDocument> {
      for (;;) {
         const server = await this.connected();
         const document = await open(server);
         if (opening.closed) {
            await this.undoOpen(server, uri, opening);
            return document;
         }
         let watched: TDocument | undefined;
         try {
            watched = await this.watchOpened(server, uri, document, created(document));
         } catch (error: unknown) {
            await this.undoOpen(server, uri, opening);
            throw error;
         }
         if (watched || opening.closed) {
            return watched ?? document;
         }
      }
   }

   /**
    * Watch a document this session just opened, and record it as open.
    * Answers `undefined`, recording nothing, when a deletion heard while the
    * watch is under way has ended the open already, and the document,
    * recording nothing, when a close has. A failed watch rejects with the open
    * still recorded, for its caller to undo, see {@link undoOpen}.
    *
    * A document created at `createdVersion` is marked in {@link createdUris}
    * while its text is still at that version: a version past it is another's,
    * a write or a repair, as a changed event would have said. Marked before the
    * watch, so an event heard while it is under way clears the mark for good,
    * and checked again against the text the watch answered, which an event
    * sent before the watch was in place moved on unheard. The restore's
    * re-open is the one other point the session learns of the text without
    * hearing the events between, and checks the mark the same way. An answer
    * without text leaves the mark as it is, at every one of the three.
    */
   protected async watchOpened<TDocument extends DataSessionDocument<TTransfer, TServer>>(
      server: RpcProxy<TServer>,
      uri: string,
      document: TDocument,
      createdVersion?: ModelVersion
   ): Promise<TDocument | undefined> {
      // Recorded before the watch, so a deletion heard while it is under way
      // finds this open, which the server made before the deletion.
      // Under the options of the earliest open still under way, which the
      // server took first; one that failed is gone from `openings` by now,
      // as the connection handles each answer in a task of its own.
      const open = this.opens.get(uri) ?? {
         serverUri: document.uri,
         deleted: false,
         options: [...(this.openings.get(uri) ?? [])].find(opening => !opening.closed)?.options
      };
      this.opens.set(uri, open);
      if (createdVersion !== undefined && (document.text === undefined || document.text.version === createdVersion)) {
         this.createdUris.add(uri);
      }
      const watched = await server.watchModelDocument({ uri, clientId: this.clientId });
      if (createdVersion !== undefined && watched.text !== undefined && watched.text.version !== createdVersion) {
         this.createdUris.delete(uri);
      }
      if (this.opens.get(uri) !== open) {
         // Sent again, it ends as an open sent after the deletion would; a
         // close is the caller's later call, and stands.
         return open.deleted ? undefined : document;
      }
      this.openUris.add(uri);
      this.recordText(uri, document);
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
      // An open called after this close waits for it instead, see `trackOpen`.
      const underWay = [...(this.openings.get(args.uri) ?? [])];
      await this.trackEnding(args.uri, async () => {
         await this.settle([this.inFlight.get(args.uri)]);
         // Forgotten before the close is sent, so a reconnect in between does
         // not re-open a document the caller has closed. Every open of it that
         // was under way when the close was called is marked, so it neither
         // records it again nor is sent again.
         underWay.forEach(opening => {
            opening.closed = true;
         });
         this.forgetDocument(args.uri);
         const server = await this.connected();
         await server.closeModelDocument({ ...args, clientId: this.clientId });
      });
   }

   /**
    * Close `uri` again after `opening` failed or was closed while under way,
    * and drop what it recorded, unless the session still relies on the open,
    * see {@link hasOpen}: the server holds one open per session and URI, so
    * the close would end that one too.
    */
   protected async undoOpen(server: RpcProxy<TServer>, uri: string, opening: DataSessionOpening<TTransfer, TServer>): Promise<void> {
      if (this.hasOpen(uri, opening)) {
         return;
      }
      this.opens.delete(uri);
      this.createdUris.delete(uri);
      await server.closeModelDocument({ uri, clientId: this.clientId }).catch(() => undefined);
   }

   /** Drop everything this session keeps of `uri`, which it no longer has open. */
   protected forgetDocument(uri: string): void {
      const serverUri = this.opens.get(uri)?.serverUri ?? uri;
      this.openUris.delete(uri);
      this.opens.delete(uri);
      this.unsavedWrites.delete(uri);
      this.lastAnswers.delete(uri);
      this.savedVersions.delete(uri);
      this.createdUris.delete(uri);
      this.host.forgetDirty?.(serverUri);
   }

   /**
    * Whether this session has `uri` open, or has an open of it under way that
    * no close has marked, other than `except`. A marked open records nothing,
    * so nothing can rely on it.
    */
   protected hasOpen(uri: string, except?: DataSessionOpening<TTransfer, TServer>): boolean {
      return this.openUris.has(uri) || [...(this.openings.get(uri) ?? [])].some(opening => opening !== except && !opening.closed);
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
      // Asked once the closes and deletes of the URI under way have answered:
      // before, the session still counts as open a document they are ending.
      for (let ending = this.endings.get(args.uri); ending; ending = this.endings.get(args.uri)) {
         await ending;
      }
      const alreadyOpen = this.hasOpen(args.uri);
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
      return this.trackWrite([args.uri], async () => {
         const server = await this.connected();
         const update = { ...args };
         const baseHash = await this.baseHashOf(server, args.uri, args.baseVersion);
         const open = this.opens.get(args.uri);
         const document = await server.updateModelDocument({ ...args, clientId: this.clientId });
         this.recordWrite(args.uri, open, document, baseHash, { update });
         return document;
      });
   }

   /**
    * Write several documents this session has open, all or none: the server
    * refuses the whole set, before any text applies, when one is stale or not
    * open. Resolves to the documents in the order given.
    */
   updateDocuments(args: DataSessionUpdatesArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>[]> {
      return this.trackWrite(
         args.updates.map(update => update.uri),
         async () => {
            // One copy for the whole call: the copy's identity is what ties its
            // records together.
            const updates = { ...args, updates: args.updates.map(update => ({ ...update })) };
            const server = await this.connected();
            const baseHashes = await Promise.all(args.updates.map(update => this.baseHashOf(server, update.uri, update.baseVersion)));
            const opens = args.updates.map(update => this.opens.get(update.uri));
            const documents = await server.updateModelDocuments({ ...args, clientId: this.clientId });
            args.updates.forEach((update, index) =>
               this.recordWrite(update.uri, opens[index], documents[index], baseHashes[index], { updates, index })
            );
            return documents;
         }
      );
   }

   /** Persist `args.model` to disk as this session. The session must have `args.uri` open. */
   saveDocument(args: DataSessionSaveArgs<TTransfer, TServer>): Promise<TransferSavedDocument<TTransfer, DiagnosticOf<TServer>>> {
      return this.trackSave(args.uri, server => server.saveModelDocument({ ...args, clientId: this.clientId }));
   }

   /**
    * Persist the text the server holds for `args.uri` as this session, with no
    * model of its own. The session must have `args.uri` open.
    */
   persistDocument(args: DataSessionPersistArgs<TTransfer, TServer>): Promise<TransferSavedDocument<TTransfer, DiagnosticOf<TServer>>> {
      return this.trackSave(args.uri, server => server.persistModelDocument({ ...args, clientId: this.clientId }));
   }

   /**
    * Delete `args.uri` as this session, at once: its file, then the document.
    * The session must have `args.uri` open. Sent once this session's calls in
    * flight on the URI have settled, as {@link closeDocument} is, and counted
    * in {@link hasSavesInFlight} until it answers.
    *
    * The session forgets the document once the delete has succeeded: on
    * hearing its own deletion, which the server sends before it answers, or
    * on the answer, for a client that hears no deletions. A refused delete
    * leaves the document open, as the server does.
    */
   deleteDocument(args: DataSessionDeleteArgs<TTransfer, TServer>): Promise<void> {
      const deleting = this.trackEnding(args.uri, () =>
         this.track([args.uri], async () => {
            this.assertLive();
            await this.settle([this.inFlight.get(args.uri)]);
            const server = await this.connected();
            const open = this.opens.get(args.uri);
            await server.deleteModelDocument({ ...args, clientId: this.clientId });
            // Still the open it was sent under: the deletion was not heard.
            if (open && this.opens.get(args.uri) === open) {
               open.deleted = true;
               this.logger.withUri(args.uri).debug('Forgot the document: this session deleted it');
               this.forgetDocument(args.uri);
            }
         })
      );
      return this.savesInFlight.track(deleting);
   }

   /** Run a save or persist of `uri` and record what it answered as saved. */
   protected trackSave(
      uri: string,
      send: (server: RpcProxy<TServer>) => Promise<TransferSavedDocument<TTransfer, DiagnosticOf<TServer>>>
   ): Promise<TransferSavedDocument<TTransfer, DiagnosticOf<TServer>>> {
      const saving = this.track([uri], async () => {
         const server = await this.connected();
         const open = this.opens.get(uri);
         const document = await send(server);
         // Sent under no open, or under one a close or deletion has ended
         // since: recorded, it would outlive that open.
         if (!open || this.opens.get(uri) !== open) {
            return document;
         }
         // Kept only when its last answer is newer than the text written. Kept
         // whenever it changed while the save ran, a record the save covered
         // survives, and a restore then reports it lost.
         const unsaved = this.unsavedWrites.get(uri);
         if (unsaved && unsaved.answer.version <= document.persisted.version) {
            this.unsavedWrites.delete(uri);
         }
         this.recordText(uri, document);
         this.createdUris.delete(uri);
         // The higher of two saves' answers, which may arrive out of order.
         const saved = this.savedVersions.get(uri);
         if (saved === undefined || document.persisted.version > saved) {
            this.savedVersions.set(uri, document.persisted.version);
         }
         return document;
      });
      return this.savesInFlight.track(saving);
   }

   /** Whether the session has ended, by {@link dispose} or {@link detach}. */
   get isDisposed(): boolean {
      return this.disposed;
   }

   /**
    * Whether a save, persist or delete of this session has not answered yet.
    * Synchronous, for a host whose exit veto must decide within the tick, such
    * as Theia's `onWillStop`.
    */
   get hasSavesInFlight(): boolean {
      return !this.savesInFlight.isIdle;
   }

   /**
    * Resolves once the saves in flight now have answered, or
    * {@link settleBeforeCloseMs} has passed. Never rejects: a failed save has
    * answered too.
    */
   whenSavesSettled(): Promise<void> {
      return this.settle([this.savesInFlight]);
   }

   /**
    * Whether an update of this session, one a restore sends again included,
    * has not answered yet. The server answers once an editor on the language
    * client holds the text, so a page that reads unsaved work from its editor
    * guards a reload on this too. Synchronous, for an unload guard that must
    * decide within the tick.
    */
   get hasWritesInFlight(): boolean {
      return !this.writesInFlight.isIdle;
   }

   /**
    * Resolves to `true` once the updates in flight now have answered, so a
    * save of the editor's documents started after it includes them, or to
    * `false` once {@link settleWritesMs} has passed first. An update sent while
    * it waits is not waited for. Never rejects.
    */
   async whenWritesSettled(): Promise<boolean> {
      if (this.writesInFlight.isIdle) {
         return true;
      }
      return (await this.clock.raceTimer(this.writesInFlight.whenSettled(), this.settleWritesMs)) !== TIMED_OUT;
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
      const settled = this.settle([...this.inFlight.values()]);
      void (async () => {
         await settled;
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
      this.opens.clear();
      this.unsavedWrites.clear();
      this.lastAnswers.clear();
      this.savedVersions.clear();
      this.createdUris.clear();
      if (!this.disposed) {
         this.disposed = true;
         this.fireDispose();
      }
   }

   /**
    * Dispose {@link dirtySubscription}, {@link updateSubscription} and
    * {@link deletionSubscription}, fire {@link onDidDispose} and dispose its
    * emitter, so a second call fires nothing.
    */
   protected fireDispose(): void {
      this.dirtySubscription?.dispose();
      this.updateSubscription?.dispose();
      this.deletionSubscription?.dispose();
      this.disposeEmitter.fire(undefined);
      this.disposeEmitter.dispose();
   }

   /**
    * Register again and restore now, after the connection dropped, instead of
    * on the next call. A no-op for a session with nothing open, which the next
    * call restores anyway, and for one already registered on the current
    * connection. A failure is retried on the connection's next ready
    * generation; a call before then meets it again.
    */
   reconnect(): void {
      if (!this.disposed && this.openUris.size > 0) {
         this.connected().catch(() => undefined);
      }
   }

   /**
    * Drop the record in {@link unsavedWrites} of a document this session has
    * open once the server says it turned clean, and its mark in
    * {@link createdUris}: it holds no unsaved text then, and a record kept
    * would have a restore report the write lost once another client's save
    * changed the file.
    *
    * The server sends a flip only for a document someone watches, so a
    * document the session writes without watching it keeps its record, and
    * can still be reported lost that way.
    */
   protected forgetSavedWrite(event: TransferDocumentDirtyChangedEvent): void {
      if (event.text?.dirty) {
         return;
      }
      // The flip names the server's key, which is not always the caller's
      // spelling that the records are kept under.
      for (const [uri, open] of this.opens) {
         if (open.serverUri === event.uri) {
            this.unsavedWrites.delete(uri);
            this.createdUris.delete(uri);
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
    *
    * The mark in {@link createdUris} goes on any such event: the unsaved text
    * is then the other client's, and a record still kept reports the
    * session's own.
    */
   protected forgetSupersededWrite(event: TransferDocumentUpdatedEvent<TTransfer, DiagnosticOf<TServer>>): void {
      if (event.reason !== 'changed' || this.isOwnEcho(event.sourceClientId)) {
         return;
      }
      for (const [uri, open] of this.opens) {
         if (open.serverUri !== event.document.uri) {
            continue;
         }
         this.createdUris.delete(uri);
         const write = this.unsavedWrites.get(uri);
         if (write && this.restoreOutcome(write, event.document) !== 'kept') {
            this.unsavedWrites.delete(uri);
         }
      }
   }

   /**
    * Forget a document whose file was deleted, which closed this session's
    * open. At once rather than after the calls in flight settle, which would
    * let a restore re-open the file that is gone. Unwatched rather than
    * closed: the server keeps the watch, and a close could end a re-open of a
    * re-created file still in flight. Unsaved writes are logged, not
    * reported: the client hears the deletion too. A document this session
    * created and never saved, deleted by no session, is reported as well: a
    * drop released it. An unsaved write breaks the set it was written with,
    * see {@link brokenSets}.
    *
    * This session's own deletion is neither unwatched nor logged as dropping
    * unsaved text: its delete released the watch, and its caller chose to
    * drop the text.
    */
   protected forgetDeletedDocument(event: TransferDocumentDeletedEvent): void {
      for (const [uri, open] of this.opens) {
         if (open.serverUri !== event.uri) {
            continue;
         }
         open.deleted = true;
         if (this.isOwnEcho(event.sourceClientId)) {
            this.logger.withUri(uri).debug('Forgot the document: this session deleted it');
            this.forgetDocument(uri);
            continue;
         }
         const write = this.unsavedWrites.get(uri);
         if (write) {
            this.brokenSets.add(setOf(write));
         }
         // Never saved, so no file a watcher could see removed: a deletion
         // naming no session is the release of the text a drop left behind.
         const released = this.createdUris.has(uri) && event.sourceClientId === UNKNOWN_CLIENT_ID;
         this.forgetGoneDocument(uri);
         if (released) {
            const reported = resolve(DATA_SESSION_UNSAVED_LOST, { uris: uri });
            this.host.reportError?.(new Error(reported.text), reported);
         }
         this.connected()
            .then(server => server.unwatchModelDocument({ uri, clientId: this.clientId }))
            .catch(() => undefined);
      }
   }

   /**
    * {@link forgetDocument} a document that is gone, logging any unsaved text
    * it drops, written or created; returns whether it dropped some.
    */
   protected forgetGoneDocument(uri: string): boolean {
      const unsaved = this.unsavedWrites.has(uri) || this.createdUris.has(uri);
      if (unsaved) {
         this.logger.withUri(uri).warn('Dropped unsaved text: the document is gone');
      } else {
         this.logger.withUri(uri).debug('Forgot the document: it is gone');
      }
      this.forgetDocument(uri);
      return unsaved;
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
    * Re-open, each under the options its {@link DataSessionOpen} holds, and
    * re-watch every document the session had open, write again what it wrote
    * since their last save where the re-open lost it, and tell the host which
    * of them lost it for good.
    *
    * Decided per document by the re-opened document's `text.hash`,
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
    * could not be re-opened, or that another client deleted, blocks its set.
    *
    * No caller is waiting, so the outcomes go through the host: one report
    * naming every document whose unsaved text is gone, whose record is then
    * dropped, and one per document that could not be re-opened or written
    * again for another reason than a conflict. A document that could not be
    * re-opened is forgotten; a failed write keeps its record, for the next
    * restore to decide again. A document closed while the restore runs, or
    * whose file is deleted then, is neither restored nor reported. One gone
    * while the connection was down, which the server reads back without a
    * model, is forgotten, and its deletion goes to the host as the deletion
    * no event brought; unsaved text it took with it is logged, as for a
    * deletion heard live, and reported as well for a document the session
    * created and never saved, which the drop released. A host that cannot
    * tell the client has the unsaved text of either reported. Once the session
    * is disposed, its caller has ended it, and the restore returns at its
    * next await: nothing more goes to the server or the host.
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
      const lost: string[] = [];
      for (const uri of [...this.openUris]) {
         // Closed, or its file deleted, while the restore ran.
         if (!this.openUris.has(uri)) {
            continue;
         }
         try {
            const options = this.opens.get(uri)?.options;
            const document = await server.openModelDocument({ uri, clientId: this.clientId, options });
            if (this.disposed) {
               return;
            }
            if (!this.openUris.has(uri)) {
               // Forgotten while it re-opened. A close of the caller's would
               // follow, but a deletion sends none.
               await server.closeModelDocument({ uri, clientId: this.clientId }).catch(() => undefined);
               continue;
            }
            // Recorded before the watch, so a deletion heard while it is under
            // way finds the re-open under the URI it answered with, which a
            // restarted server may key differently.
            this.opens.set(uri, { serverUri: document.uri, deleted: false, options });
            await server.watchModelDocument({ uri, clientId: this.clientId }).catch(async (error: unknown) => {
               // Closed, or the server holds the re-open until the session
               // ends; no other call relies on it while the restore runs.
               await server.closeModelDocument({ uri, clientId: this.clientId }).catch(() => undefined);
               throw error;
            });
            if (this.disposed) {
               return;
            }
            if (this.openUris.has(uri)) {
               // Text other than this session last saw was written while the
               // connection was down, by an event it never heard.
               const known = this.lastAnswers.get(uri);
               if (this.createdUris.has(uri) && document.text !== undefined && known !== undefined && document.text.hash !== known.hash) {
                  this.createdUris.delete(uri);
               }
               this.recordText(uri, document);
            }
            reopened.set(uri, document);
         } catch (error: unknown) {
            // Gone while the connection was down, which no deletion told the
            // session of: the server answers a read of it without a model.
            const read = await server.getModelDocument({ uri }).catch(() => undefined);
            if (this.disposed) {
               return;
            }
            // Forgotten meanwhile, so nothing is lost.
            if (!this.openUris.has(uri)) {
               continue;
            }
            if (read && !read.model) {
               const write = this.unsavedWrites.get(uri);
               // Named as the client last heard it, by the open's answer.
               const serverUri = this.opens.get(uri)?.serverUri ?? uri;
               // Never saved, so the drop released it and no one deleted it.
               const created = this.createdUris.has(uri);
               const unsaved = this.forgetGoneDocument(uri);
               // Kept for `reapply`, where it blocks its set as a document
               // that could not be re-opened does, and goes.
               if (write) {
                  this.unsavedWrites.set(uri, write);
               }
               if (!this.host.restoreDeletion) {
                  // No client hears of the deletion, so the loss is reported.
                  if (unsaved) {
                     lost.push(uri);
                  }
                  continue;
               }
               // The client hears of the deletion, so unsaved text is logged,
               // as for one heard live; the drop's release is reported too.
               if (created) {
                  lost.push(uri);
               }
               try {
                  this.host.restoreDeletion({ uri: serverUri, sourceClientId: UNKNOWN_CLIENT_ID });
               } catch {
                  // The client's listener failed, not the restore.
               }
               continue;
            }
            // Its record goes with its set's, in `reapply`, which it blocks.
            this.openUris.delete(uri);
            this.opens.delete(uri);
            this.lastAnswers.delete(uri);
            this.savedVersions.delete(uri);
            this.createdUris.delete(uri);
            this.host.reportError?.(error, resolve(DATA_SESSION_RESTORE_FAILED, { uri, detail: describeError(error) }));
         }
      }
      const sets = new Map<object, [string, DataSessionUnsavedWrite<TTransfer, TServer>][]>();
      for (const [uri, write] of writes) {
         const set = setOf(write);
         sets.set(set, [...(sets.get(set) ?? []), [uri, write]]);
      }
      for (const members of sets.values()) {
         lost.push(...(await this.reapply(server, members, reopened)));
         if (this.disposed) {
            return;
         }
      }
      for (const uri of reopened.keys()) {
         if (!this.openUris.has(uri)) {
            continue;
         }
         // A failed read, or one without text, leaves the client's dirty
         // state as it was; the document is restored all the same.
         const current = await server.getModelDocument({ uri }).catch(() => undefined);
         if (this.disposed) {
            return;
         }
         // Again after the read: one closed or deleted meanwhile has no
         // state to tell.
         if (current?.text !== undefined && this.openUris.has(uri)) {
            // A created document reads clean only once a save gave it a
            // baseline, so its text is no longer unsaved. A write record
            // stays: a reverted document reads clean too, its write unsent.
            if (!current.text.dirty) {
               this.createdUris.delete(uri);
            }
            try {
               this.host.restoreDirty?.({ uri: current.uri, text: current.text });
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
    * A document without `text` comes from a server that sends none, and
    * counts as kept only at the version the write was answered with. One
    * without a model has no version to send the write again on.
    */
   protected restoreOutcome(
      write: DataSessionUnsavedWrite<TTransfer, TServer>,
      document: DataSessionDocument<TTransfer, TServer>
   ): 'kept' | 'resend' | 'lost' {
      if (document.text === undefined) {
         return document.model?.version === write.answer.version ? 'kept' : 'lost';
      }
      if (document.text.hash === write.answer.hash) {
         return 'kept';
      }
      return document.model && write.baseHash !== undefined && document.text.hash === write.baseHash ? 'resend' : 'lost';
   }

   /**
    * Write again, in one call and based on their `reopened` versions, the
    * `members` of one write call that the re-open lost, all or none. Returns
    * the URIs whose unsaved text is gone, and drops their records, and the
    * record of a member that could not be re-opened.
    *
    * A member whose record is no longer the one the restore started with was
    * closed, saved or disposed meanwhile, and is left out: writing it would
    * put back text its caller discarded. A set in {@link brokenSets} is
    * not written again.
    *
    * Sent as a `restore`: a model the server took was written over text that
    * parsed, so it is complete even where the reopened text does not parse.
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
            this.unsavedWrites.set(uri, { ...write, answer: this.answerOf(uri, document) });
         }
      }
      // A document that could not be re-opened is forgotten, and was reported
      // as such; one closed, saved or deleted while a write ran lost nothing.
      const lose = (): string[] => {
         const gone = outcomes.filter(member => member.outcome !== 'kept' && current(member.uri, member.write));
         gone.forEach(member => {
            this.unsavedWrites.delete(member.uri);
            this.createdUris.delete(member.uri);
         });
         return gone.filter(member => member.outcome === 'lost' || member.outcome === 'resend').map(member => member.uri);
      };
      if (this.brokenSets.has(setOf(members[0][1])) || outcomes.some(member => member.outcome === 'lost' || member.outcome === 'failed')) {
         return lose();
      }
      // In the order of the call's updates, which is the order of its answers.
      const resend = outcomes
         .flatMap(({ uri, write, document, outcome }) =>
            outcome === 'resend' && document?.model ? [{ uri, write, baseVersion: document.model.version }] : []
         )
         .sort((left, right) => indexOf(left.write) - indexOf(right.write));
      if (resend.length === 0) {
         return [];
      }
      const opens = resend.map(member => this.opens.get(member.uri));
      let documents: DataSessionDocument<TTransfer, TServer>[];
      try {
         const { call } = resend[0].write;
         if ('update' in call) {
            documents = [
               await this.writesInFlight.track(
                  server.updateModelDocument({ ...call.update, baseVersion: resend[0].baseVersion, restore: true, clientId: this.clientId })
               )
            ];
         } else {
            const baseVersion = new Map(resend.map(member => [indexOf(member.write), member.baseVersion]));
            documents = await this.writesInFlight.track(
               server.updateModelDocuments({
                  ...call.updates,
                  clientId: this.clientId,
                  updates: call.updates.updates.flatMap((update, index) => {
                     const version = baseVersion.get(index);
                     return version === undefined ? [] : [{ ...update, baseVersion: version, restore: true }];
                  })
               })
            );
         }
      } catch (error: unknown) {
         if (isConflictError(error)) {
            return lose();
         }
         for (const { uri, write, baseVersion } of resend) {
            // Closed, saved or deleted while the write ran: nothing to restore.
            if (!current(uri, write)) {
               continue;
            }
            this.host.reportError?.(error, resolve(DATA_SESSION_RESTORE_FAILED, { uri, detail: describeError(error) }));
            // Kept for the next restore, and numbered from the re-opened
            // version, as the kept records are: a record numbered by a server
            // that has since restarted would have later answers ignored.
            this.unsavedWrites.set(uri, { ...write, answer: { ...write.answer, version: baseVersion } });
         }
         return [];
      }
      resend.forEach((member, index) => {
         if (current(member.uri, member.write)) {
            // Recorded afresh, since the answer of a restarted server may be
            // numbered below the one it replaces.
            this.unsavedWrites.delete(member.uri);
            this.recordWrite(member.uri, opens[index], documents[index], member.write.baseHash, member.write.call);
         }
      });
      return [];
   }

   /**
    * The text hash of the version `baseVersion` names for `uri`, for a write that
    * starts the URI's record in {@link unsavedWrites}; `undefined` for any
    * other write, whose record keeps the base it has.
    *
    * Taken from {@link lastAnswers} when that is at the version, otherwise
    * read, and kept only when the read answers that version: a server's text
    * changes only with its version, so the text at a version is the text the
    * write, once it passes the gate, was applied to.
    */
   protected async baseHashOf(server: RpcProxy<TServer>, uri: string, baseVersion: BaseVersion): Promise<string | undefined> {
      if (this.unsavedWrites.has(uri) || !isModelVersion(baseVersion)) {
         return undefined;
      }
      const known = this.lastAnswers.get(uri);
      if (known?.version === baseVersion) {
         return known.hash;
      }
      const read = await server.getModelDocument({ uri }).catch(() => undefined);
      return read?.text?.version === baseVersion ? read.text.hash : undefined;
   }

   /**
    * Record `document` as the answer to a write of `uri` sent under `open`,
    * keeping the base of the URI's record if it has one. An answer sent under
    * no open, or under one that has ended, is ignored. So is one numbered below
    * the record's: two writes of `uri` in flight at once may answer out of
    * order, and the record holds the one applied last.
    *
    * So is one numbered at or below the URI's entry in {@link savedVersions}.
    * The save came after that write was applied, so the save persisted its
    * text or a later write replaced it, and its answer carries the text as it
    * was when sent, which a restore would report as lost.
    */
   protected recordWrite(
      uri: string,
      open: DataSessionOpen<TTransfer, TServer> | undefined,
      document: DataSessionDocument<TTransfer, TServer>,
      baseHash: string | undefined,
      call: DataSessionUnsavedWrite<TTransfer, TServer>['call']
   ): void {
      // Recorded, it would outlive that open.
      if (!open || this.opens.get(uri) !== open) {
         return;
      }
      const answer = this.answerOf(uri, document);
      const kept = this.unsavedWrites.get(uri);
      if (kept && answer.version < kept.answer.version) {
         return;
      }
      const saved = this.savedVersions.get(uri);
      if (saved !== undefined && answer.version <= saved) {
         return;
      }
      this.unsavedWrites.set(uri, { baseHash: kept ? kept.baseHash : baseHash, answer, call });
      this.recordText(uri, document);
   }

   /**
    * What {@link DataSessionUnsavedWrite.answer} keeps of `document`. Every write
    * and open answers with a model; one without is reported and counted older
    * than every version, so it never replaces a real answer.
    */
   protected answerOf(
      uri: string,
      document: DataSessionDocument<TTransfer, TServer>
   ): DataSessionUnsavedWrite<TTransfer, TServer>['answer'] {
      if (!document.model) {
         const reported = resolve(DATA_SESSION_ANSWER_WITHOUT_MODEL, { uri });
         this.host.reportError?.(new Error(reported.text), reported);
         return { version: UNRECORDED_VERSION, hash: document.text?.hash };
      }
      return { version: document.model.version, hash: document.text?.hash };
   }

   /** Keep `document`'s text in {@link lastAnswers}, or forget it for a server that sends none. */
   protected recordText(uri: string, document: DataSessionDocument<TTransfer, TServer>): void {
      if (document.text) {
         this.lastAnswers.set(uri, document.text);
      } else {
         this.lastAnswers.delete(uri);
      }
   }

   /** Run `call`, counted as in flight on each of `uris` until it settles. */
   protected track<T>(uris: readonly string[], call: () => Promise<T>): Promise<T> {
      const running = call();
      for (const uri of uris) {
         let tracker = this.inFlight.get(uri);
         if (tracker === undefined) {
            tracker = new PendingWorkTracker();
            this.inFlight.set(uri, tracker);
         }
         tracker.track(running);
      }
      return running;
   }

   /** {@link track} an update of `uris`, counted in {@link writesInFlight} too. */
   protected trackWrite<T>(uris: readonly string[], call: () => Promise<T>): Promise<T> {
      return this.writesInFlight.track(this.track(uris, call));
   }

   /**
    * {@link track} an open of `uri`, kept in {@link openings} until it settles,
    * and sent once the closes and deletes of `uri` called before it have
    * answered.
    */
   protected trackOpen<T>(
      uri: string,
      options: DataSessionOpenOptions<TTransfer, TServer>,
      call: (opening: DataSessionOpening<TTransfer, TServer>) => Promise<T>
   ): Promise<T> {
      const opening: DataSessionOpening<TTransfer, TServer> = { closed: false, options };
      const openings = this.openings.get(uri) ?? new Set<DataSessionOpening<TTransfer, TServer>>();
      this.openings.set(uri, openings.add(opening));
      const done = (): void => {
         openings.delete(opening);
         if (openings.size === 0 && this.openings.get(uri) === openings) {
            this.openings.delete(uri);
         }
      };
      const ending = this.endings.get(uri);
      const running = this.track([uri], () => (ending ? ending.then(() => call(opening)) : call(opening)));
      running.then(done, done);
      return running;
   }

   /**
    * Run `end`, a close or delete of `uri`, kept in {@link endings} until it
    * and every earlier one of `uri` have settled.
    */
   protected trackEnding(uri: string, end: () => Promise<void>): Promise<void> {
      const ending = end();
      const settled = Promise.allSettled([this.endings.get(uri), ending]);
      this.endings.set(uri, settled);
      void settled.then(() => {
         if (this.endings.get(uri) === settled) {
            this.endings.delete(uri);
         }
      });
      return ending;
   }

   /** Wait until the work `trackers` hold now has settled, or {@link settleBeforeCloseMs} has passed. */
   protected async settle(trackers: Iterable<PendingWorkTracker | undefined>): Promise<void> {
      const pending = [...trackers].filter((tracker): tracker is PendingWorkTracker => tracker !== undefined && !tracker.isIdle);
      if (pending.length === 0) {
         return;
      }
      await this.clock.raceTimer(Promise.all(pending.map(tracker => tracker.whenSettled())), this.settleBeforeCloseMs);
   }

   /**
    * Throw a `SessionClosedError` once the session has ended. {@link connected}
    * runs it again after each of its waits, since a session disposed during
    * one would otherwise register or send after the close.
    */
   protected assertLive(): void {
      if (this.disposed) {
         throw new SessionClosedError(this.clientId);
      }
   }
}
