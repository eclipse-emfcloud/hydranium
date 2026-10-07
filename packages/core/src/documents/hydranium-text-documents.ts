/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 * Copyright (c) Microsoft Corporation and EclipseSource. All rights reserved.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Adapted from Langium's `NormalizedTextDocuments`, itself an adaptation of
// Microsoft's `TextDocuments` — hence the Microsoft copyright above. The
// `listen()` override below follows that handler-registration sequence:
// https://github.com/microsoft/vscode-languageserver-node/blob/8f5fa710d3a9f60ff5e7583a9e61b19f86e39da3/server/src/common/textDocuments.ts

// Deliberate exception to `@hydranium/core`'s no-runtime-langium/lsp rule:
// this class IS the shared LSP-style document-sync primitive that every
// protocol head (lsp-server, data-server, glsp-server) coordinates through.
// Moving it into lsp-server would force data-server / glsp-server to depend
// on lsp-server, contradicting the peer architecture.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { NormalizedTextDocuments } from '@hydranium/langium/lsp';
import { type URI, UriUtils } from '@hydranium/langium';
import { type ServerSharedServices } from '../langium/module.js';
import {
   type ApplyWorkspaceEditResult,
   type CancellationToken,
   type Connection,
   type DidChangeTextDocumentParams,
   type DidCloseTextDocumentParams,
   type DidOpenTextDocumentParams,
   type DidSaveTextDocumentParams,
   type Disposable,
   Emitter,
   type Event,
   type HandlerResult,
   OptionalVersionedTextDocumentIdentifier,
   type RequestHandler,
   type TextDocumentChangeEvent,
   TextDocumentEdit,
   TextDocumentSyncKind,
   type TextDocumentWillSaveEvent,
   type TextDocumentsConfiguration,
   type TextEdit,
   type WillSaveTextDocumentParams
} from 'vscode-languageserver';
import { type DocumentUri, TextDocument, type TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';
import {
   type CanonicalUri,
   type LanguageClientUri,
   asLanguageClientUri,
   DisposableCollection,
   type TextState,
   type TextVersion,
   STALE_VERSION,
   type Tracer,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { LANGUAGE_CLIENT_ID } from './client-ids.js';
import { INTEGRITY_CLIENT_ID } from '../langium/integrity/integrity-rule.js';
import { type ClientSessionClosedEvent, ClientSessionRegistry, type SessionEndCause } from './client-session-registry.js';
import { DefaultLanguageClientShadow, type LanguageClientChangeVerdict, type LanguageClientShadow } from './language-client-shadow.js';
import { DefaultTextLedger, type TextLedger } from './text-ledger.js';
import { isDocumentReleaseSkippedError, type ReleasedDocument } from './document-release-handler.js';
import { DefaultDocumentReleaseScheduler, type DocumentReleaseScheduler } from './document-release-scheduler.js';
import {
   type CleanAnnouncement,
   DefaultDirtyStateTracker,
   type DirtyStateTracker,
   type DocumentDirtyChangedEvent
} from './dirty-state-tracker.js';

/**
 * The LSP spec's "version is intentionally unknown" for an
 * {@link OptionalVersionedTextDocumentIdentifier} is `null`, but
 * `OptionalVersionedTextDocumentIdentifier.create` requires `number` in its TS
 * signature — so the null routes through this one typed bridge rather than a
 * cast at each call site.
 */
const UNKNOWN_CLIENT_VERSION = null as unknown as number;

export interface ClientTextDocumentChangeEvent<T> extends TextDocumentChangeEvent<T> {
   clientId: string;
}

/**
 * Construction options for {@link HydraniumTextDocuments}. All fields optional —
 * defaults reproduce the framework's behaviour exactly.
 */
export interface HydraniumTextDocumentsOptions<T extends TextDocument = TextDocument> extends LogNameOptions {
   /**
    * Factory for the text-document type `T` (provides `create` / `update`).
    * Defaults to `TextDocument` from `vscode-languageserver-textdocument`.
    * Adopters with a custom text-document type (rare) pass their factory.
    */
   readonly configuration?: TextDocumentsConfiguration<T>;
   /**
    * How long a document whose last open closed because its client's
    * connection was lost keeps its text before the store releases it. An open
    * by a client lost from the document, within this time of its own loss,
    * cancels the release, so a client that registers again under its id after
    * a dropped connection finds its unsaved edits. Any other open releases the
    * document first and then opens it as a first open does, from the text the
    * opener supplies (an editor's own) or else from the file. Meanwhile the
    * document counts as open for the integrity service, which therefore writes
    * none of its unsaved text to disk. A close the client makes itself, or
    * ending its session, releases at once whatever this is.
    *
    * Defaults to 10 s. `0` releases such a document at once as well, in the
    * close itself rather than on a timer.
    */
   readonly releaseGraceMs?: number;
}

/**
 * The default of {@link HydraniumTextDocumentsOptions.releaseGraceMs}: long
 * enough for a client whose connection dropped to register again and reopen
 * its documents, which a data client does as soon as it has a connection.
 */
const DEFAULT_RELEASE_GRACE_MS = 10_000;

/** Delivered by {@link HydraniumTextDocuments.onDidSaveInLanguageClient}. */
export interface LanguageClientSavedEvent {
   readonly uri: string;
}

/** Delivered by {@link HydraniumTextDocuments.onDidReleaseDocument}. */
export interface DocumentReleasedEvent {
   readonly uri: CanonicalUri;
}

/**
 * A document held open by at least one client, with the client ids holding it —
 * one entry of {@link HydraniumTextDocuments.openDocuments}.
 */
export interface OpenDocument {
   /** Canonical identity the store keys the document by. */
   readonly uri: CanonicalUri;
   /** Client ids currently holding the document open (never empty). */
   readonly clients: readonly string[];
}

/**
 * What {@link HydraniumTextDocuments.commitRepair} did with an integrity repair.
 *
 * Three outcomes rather than a document-or-nothing, because the two ways of
 * getting nothing call for opposite responses: `not-open` means there is no
 * store document to correct and the caller carries on with the one it holds,
 * while `stale` means there IS one and it has moved past the text the repair
 * was computed against — so carrying on would persist a correction over an edit
 * that superseded it. Collapsing them lets the second read as permission to
 * proceed, which is the failure this shape exists to make unrepresentable.
 */
export type RepairCommit<T extends TextDocument> =
   | { readonly status: 'committed'; readonly document: T }
   | { readonly status: 'stale' }
   | { readonly status: 'not-open' };

/**
 * The one field of `vscode-languageserver`'s `Connection` this class has to
 * reach that its public type does not declare. Named here rather than cast
 * inline so the write states which shape it assumes.
 */
interface ConnectionWithTextDocumentSync {
   __textDocumentSync?: TextDocumentSyncKind;
}

/**
 * The one text store every head writes to, on top of Langium's
 * `NormalizedTextDocuments`, and the LSP text-sync endpoint: every
 * `textDocument/*` notification and every `workspace/applyEdit` push goes
 * through here.
 *
 * Each open, change, close and save is one synchronous transition over the
 * held document and the collaborators its `create…` methods build. A
 * collaborator that defers its part lets a listener of the transition's event
 * read state from before it. A document no client holds any more is
 * released to the `DocumentReleaseHandler` slot, after
 * {@link HydraniumTextDocumentsOptions.releaseGraceMs} when its last client's
 * connection was lost.
 *
 * Client-declared version ids feed only the per-client staleness guard and
 * never a running shared sequence: the two count different things, and
 * splicing them lets versions drift past base-version gate holders. A URI
 * with no ledger record and no built root starts at its opener's declared id:
 * no version was handed out for it.
 *
 * `didOpen` notifications arriving over the LSP connection wait on the
 * workspace-ready promise, so a client's first open cannot race workspace
 * discovery. Direct {@link notifyDidOpenTextDocument} calls (the non-LSP
 * heads) do not pass that gate — their caller owns the ordering.
 */
export class HydraniumTextDocuments<T extends TextDocument = TextDocument> extends NormalizedTextDocuments<T> {
   /** Content staged by integrity rules for a document no client holds, consumed by its first open. */
   protected readonly __pendingContent = new Map<CanonicalUri, string>();

   /**
    * Which client has which document open, which client ids are registered
    * sessions, and each client's declared version, the staleness guard's
    * baseline. Every open-state predicate on this class reads it, so an open
    * recorded anywhere else is invisible to the last-close transition.
    */
   protected readonly __sessions = new ClientSessionRegistry();

   /** The version each open document was opened at; see {@link openedVersion}. */
   protected readonly __openedVersions = new Map<CanonicalUri, TextVersion>();

   protected readonly tracer: Tracer;
   protected readonly configuration: TextDocumentsConfiguration<T>;
   protected __textLedger: TextLedger | undefined;
   protected __languageClientShadow: LanguageClientShadow | undefined;
   protected __dirtyStateTracker: DirtyStateTracker | undefined;
   protected __documentReleaseScheduler: DocumentReleaseScheduler | undefined;
   protected readonly documentReleasedEmitter = new Emitter<DocumentReleasedEvent>();
   protected readonly languageClientSavedEmitter = new Emitter<LanguageClientSavedEvent>();

   constructor(
      protected services: ServerSharedServices,
      protected readonly options: HydraniumTextDocumentsOptions<T> = {}
   ) {
      const configuration = options.configuration ?? (TextDocument as unknown as TextDocumentsConfiguration<T>);
      super(configuration);
      this.configuration = configuration;
      this.tracer = services.Tracer.for(options.logName ?? 'TextDocuments').trace('instantiated');
   }

   // Each collaborator is built on first use, after every constructor has run,
   // so a create method may read its subclass's fields and the other collaborators.

   protected get textLedger(): TextLedger {
      return (this.__textLedger ??= this.createTextLedger());
   }

   protected get languageClientShadow(): LanguageClientShadow {
      return (this.__languageClientShadow ??= this.createLanguageClientShadow());
   }

   protected get dirtyStateTracker(): DirtyStateTracker {
      return (this.__dirtyStateTracker ??= this.createDirtyStateTracker());
   }

   protected get documentReleaseScheduler(): DocumentReleaseScheduler {
      return (this.__documentReleaseScheduler ??= this.createDocumentReleaseScheduler());
   }

   protected createTextLedger(): TextLedger {
      return new DefaultTextLedger();
   }

   protected createLanguageClientShadow(): LanguageClientShadow {
      return new DefaultLanguageClientShadow(this, this.tracer);
   }

   protected createDirtyStateTracker(): DirtyStateTracker {
      return new DefaultDirtyStateTracker(this.textLedger);
   }

   protected createDocumentReleaseScheduler(): DocumentReleaseScheduler {
      return new DefaultDocumentReleaseScheduler(this.services.Clock, this.options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS);
   }

   /** Hold `document` as the text of `key`, a new version authored by `author`. */
   protected commitText(key: CanonicalUri, document: T, author: string): void {
      this.__syncedDocuments.set(key, document);
      this.setAuthor(key, document.version, author);
      this.dirtyStateTracker.refreshDirty(key, document);
   }

   /**
    * Apply `changes` to `document`, the held text of `key`, and hold the
    * result. The version steps only when the text changes, which is what a
    * base-version gate relies on: unchanged text keeps its version and its
    * author. The new text is known only once the changes are applied, so they
    * go in at a tentative step that an identical result rolls back.
    */
   protected commitChange(
      key: CanonicalUri,
      document: T,
      changes: TextDocumentContentChangeEvent[],
      author: string
   ): { document: T; changed: boolean } {
      const previousText = document.getText();
      const version = document.version;
      let next = this.update(document, changes, version + 1);
      const changed = next.getText() !== previousText;
      if (changed) {
         this.commitText(key, next, author);
      } else {
         // An empty-changes update only re-stamps the version.
         next = this.update(next, [], version);
         this.__syncedDocuments.set(key, next);
      }
      return { document: next, changed };
   }

   // The configuration's factories. Every document the store makes or changes
   // goes through them, so an override sees each call: the store's own writes,
   // callers outside the didOpen/didChange flow, and the shadow's throwaway
   // probes, at version 0 under a client URI.

   public create(uri: string, languageId: string, version: number, content: string): T {
      return this.configuration.create(uri, languageId, version, content);
   }

   public update(document: T, changes: TextDocumentContentChangeEvent[], version: number): T {
      return this.configuration.update(document, changes, version);
   }

   protected get __syncedDocuments(): Map<string, T> {
      return this['_syncedDocuments'];
   }

   protected get __onDidChangeContent(): Emitter<ClientTextDocumentChangeEvent<T>> {
      return this['_onDidChangeContent'];
   }

   override get onDidChangeContent(): Event<ClientTextDocumentChangeEvent<T>> {
      return this.__onDidChangeContent.event;
   }

   protected get __onDidOpen(): Emitter<ClientTextDocumentChangeEvent<T>> {
      return this['_onDidOpen'];
   }

   override get onDidOpen(): Event<ClientTextDocumentChangeEvent<T>> {
      return this.__onDidOpen.event;
   }

   protected get __onDidClose(): Emitter<ClientTextDocumentChangeEvent<T>> {
      return this['_onDidClose'];
   }

   override get onDidClose(): Event<ClientTextDocumentChangeEvent<T>> {
      return this.__onDidClose.event;
   }

   protected get __onDidSave(): Emitter<ClientTextDocumentChangeEvent<T>> {
      return this['_onDidSave'];
   }

   override get onDidSave(): Event<ClientTextDocumentChangeEvent<T>> {
      return this['__onDidSave'].event;
   }

   protected get __onWillSave(): Emitter<TextDocumentWillSaveEvent<T>> {
      return this['_onWillSave'];
   }

   protected get __willSaveWaitUntil(): RequestHandler<TextDocumentWillSaveEvent<T>, TextEdit[], void> | undefined {
      return this['_willSaveWaitUntil'];
   }

   public override listen(connection: Connection): Disposable {
      // The advertised `textDocumentSync` capability is read off this field
      // while `initialize` is answered, and it falls back to
      // `TextDocumentSyncKind.None` when the field holds anything but a number
      // — at which point the client stops sending change notifications at all
      // and every document goes stale after its first open. Upstream's own
      // `TextDocuments.listen` performs this write; replacing that class means
      // taking it over. The field is private to `vscode-languageserver`, so on
      // a bump of the pinned wire chain re-check that it still exists: a rename
      // makes this line a silent no-op, whose symptom is no `didChange` traffic
      // rather than an error.
      (connection as unknown as ConnectionWithTextDocumentSync).__textDocumentSync = TextDocumentSyncKind.Incremental;
      const disposables = new DisposableCollection();
      disposables.push(
         connection.onDidOpenTextDocument(async (event: DidOpenTextDocumentParams) => {
            await this.initialBuildFinished();
            this.notifyDidOpenTextDocument(event);
         })
      );
      disposables.push(
         connection.onDidChangeTextDocument((event: DidChangeTextDocumentParams) => {
            this.notifyDidChangeTextDocument(event);
         })
      );
      disposables.push(
         connection.onDidCloseTextDocument((event: DidCloseTextDocumentParams) => {
            this.notifyDidCloseTextDocument(event);
         })
      );
      disposables.push(
         connection.onWillSaveTextDocument((event: WillSaveTextDocumentParams) => {
            this.notifyWillSaveTextDocument(event);
         })
      );
      disposables.push(
         connection.onWillSaveTextDocumentWaitUntil((event: WillSaveTextDocumentParams, token: CancellationToken) =>
            this.notifyWillSaveTextDocumentWaitUntil(event, token)
         )
      );
      disposables.push(
         connection.onDidSaveTextDocument((event: DidSaveTextDocumentParams) => {
            void this.notifyLanguageClientSave(event);
         })
      );
      return disposables;
   }

   public notifyDidChangeTextDocument(event: DidChangeTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const td = event.textDocument;
      const changes = event.contentChanges;
      if (changes.length === 0) {
         return;
      }

      const { version } = td;
      if (version === null || version === undefined) {
         throw new Error(`Received document change event for ${td.uri} without valid version identifier`);
      }

      const uri = this.documentKey(td.uri);
      let document = this.__syncedDocuments.get(uri);
      if (document !== undefined) {
         // Client version ids are the client's own, so compared against what
         // that client declared, never against the shared version: an authored
         // write advances that without the client knowing, and gating on it
         // drops real edits. The editor is checked per URI, since each is its
         // own buffer; its client-wide entry is only the fallback for a URI it
         // never opened, and may name another URI's buffer. A client with no
         // baseline falls back to the shared version.
         const clientUri = this.toLanguageClientUri(td.uri);
         const editor = clientId === LANGUAGE_CLIENT_ID;
         const lastSeen =
            (editor ? this.languageClientShadow.declaredVersion(uri, clientUri) : undefined) ??
            this.__sessions.clientVersionOf(uri, clientId) ??
            document.version;
         if (lastSeen >= td.version) {
            // Distinguish "already at this version" (common: an echo from the client that triggered
            // the update) from "incoming version older than ours" (stale race).
            const reason =
               lastSeen === td.version ? `already at version ${lastSeen}` : `incoming version ${td.version} older than current ${lastSeen}`;
            this.logUri(uri, `Ignore update by ${this.formatClientId(clientId)}: ${reason}`, 'debug');
            return;
         }
         this.__sessions.setClientVersion(uri, clientId, td.version);

         // An editor change is keyed to the buffer the editor holds, which is
         // the synced text only while the two agree — an authored write
         // advances the synced text without the editor knowing, and a push in
         // flight moves the editor without the store knowing.
         const verdict: LanguageClientChangeVerdict = editor
            ? this.languageClientShadow.acceptChange(uri, clientUri, td.version, document, changes)
            : { kind: 'direct' };
         if (verdict.kind === 'echo') {
            // The synced document is already there, so the changes must not be
            // applied a second time: nothing is minted and no rebuild fires. The
            // shadow keeps the newest pushed text, which is what the next
            // outbound diff has to be keyed to.
            this.logUri(uri, `Skip rebuild: echo of a server-authored push (client version ${td.version})`, 'debug');
            return;
         }

         // A divergent change is applied as its reconstructed text rather than
         // as its own ranges: those ranges address the editor's own buffer, so
         // applying them here would splice the wrong lines.
         const committed = this.commitChange(uri, document, verdict.kind === 'direct' ? changes : [{ text: verdict.text }], clientId);
         document = committed.document;
         if (editor) {
            this.languageClientShadow.setClientText(clientUri, document.getText());
            // Content-identical echo: the editor is echoing text we already had.
            // The model is unchanged, so skip the rebuild. Restricted to the
            // editor: a ModelService-authored change is never skipped.
            if (!committed.changed) {
               this.logUri(uri, `Skip rebuild: content unchanged (echo at client version ${td.version})`, 'debug');
               return;
            }
         }
         this.log(
            document.uri,
            `Update to version ${document.version} by ${this.formatClientId(clientId)}${committed.changed ? '' : ' (content unchanged)'}`
         );
         this.__onDidChangeContent.fire(Object.freeze({ document, clientId }));
      }
   }

   /**
    * Apply a full-text content change authored server-side (ModelService /
    * GLSP / integrity — any writer that is not an LSP wire client). The store
    * assigns the shared version itself: step iff `text` differs from the
    * current synced content, keep otherwise. Contrast
    * {@link notifyDidChangeTextDocument}, the LSP wire path, where the client
    * declares ITS version id and that id feeds only the per-client staleness
    * guard.
    *
    * A content-identical write still fires the change event (rebuild): the
    * authored write's server-side rebuild is correctness-bearing, it just
    * mints no new version — nothing observable changed, so watchers'
    * base versions stay valid.
    *
    * Returns the resulting shared version. Throws when the document is not
    * open — callers (`AstDocumentManager.update`) open first.
    */
   applyContentChange(uri: DocumentUri, text: string, clientId: string): TextVersion {
      const key = this.documentKey(uri);
      const synced = this.__syncedDocuments.get(key);
      if (synced === undefined) {
         throw new Error(`Document ${uri} is not open for content changes`);
      }
      // Unchanged text calls no update: a configuration may return a new document for one.
      const { document, changed } =
         synced.getText() === text ? { document: synced, changed: false } : this.commitChange(key, synced, [{ text }], clientId);
      this.log(
         document.uri,
         `Update to version ${document.version} by ${this.formatClientId(clientId)}${changed ? '' : ' (content unchanged)'}`
      );
      this.__onDidChangeContent.fire(Object.freeze({ document, clientId }));
      return document.version;
   }

   /**
    * Close `clientId`'s open of the document. When it was the last open, the
    * document is released, at once or, for a `'lost'`
    * close, after {@link HydraniumTextDocumentsOptions.releaseGraceMs}.
    */
   public notifyDidCloseTextDocument(
      event: DidCloseTextDocumentParams,
      clientId = LANGUAGE_CLIENT_ID,
      cause: SessionEndCause = 'closed'
   ): void {
      const uri = this.documentKey(event.textDocument.uri);
      if (clientId === LANGUAGE_CLIENT_ID) {
         const clientUri = this.toLanguageClientUri(event.textDocument.uri);
         // A close under a URI the editor never opened the document under ends its hold.
         if (this.languageClientShadow.isOpen(uri, clientUri)) {
            this.languageClientShadow.removeOpen(uri, clientUri);
         } else {
            this.languageClientShadow.removeAllOpens(uri);
         }
         // Another URI still holds the document, so only this one's buffer goes.
         if (this.languageClientShadow.isOpen(uri)) {
            return;
         }
      }
      if (!this.__sessions.removeOpen(uri, clientId)) {
         return;
      }
      if (cause === 'lost') {
         this.documentReleaseScheduler.recordLoss(uri, clientId);
      }
      const syncedDocument = this.__syncedDocuments.get(uri);
      if (syncedDocument !== undefined) {
         this.log(syncedDocument.uri, `Closed synced document: ${syncedDocument.version} by ${this.formatClientId(clientId)}`);
         this.__onDidClose.fire(Object.freeze({ document: syncedDocument, clientId }));
         if (!this.isOpenInAnyClient(uri)) {
            if (cause === 'lost') {
               this.deferRelease(uri);
            } else {
               this.releaseDocument(uri);
            }
         }
      }
   }

   /**
    * Keep the document, text and all, for the release grace, then release it.
    * The document stays in the store meanwhile, so a lost client that opens it
    * again within its own grace attaches to it and finds its unsaved text
    * rather than reading disk; see {@link resolveDeferredRelease} for any other
    * open.
    */
   protected deferRelease(uri: CanonicalUri): void {
      this.documentReleaseScheduler.defer(uri, () => {
         if (!this.isOpenInAnyClient(uri)) {
            this.releaseDocument(uri);
         }
      });
      if (this.documentReleaseScheduler.isDeferred(uri)) {
         this.log(uri, `No client left; release deferred for ${this.documentReleaseScheduler.graceMs} ms (connection lost)`);
      }
   }

   /** Resolve a deferred release of `uri` for an open by `clientId`: a release the scheduler decides on runs now. */
   protected resolveDeferredRelease(uri: CanonicalUri, clientId: string): void {
      if (this.documentReleaseScheduler.resolveOpen(uri, clientId) === 'release') {
         this.releaseDocument(uri);
      }
   }

   /**
    * Drop the document no client has open any more, announce it on
    * {@link onDidReleaseDocument}, then hand it to the
    * `DocumentReleaseHandler` slot: its listeners, such as the update
    * handler dropping a change it still holds back, act before any build the
    * handler runs.
    */
   protected releaseDocument(uri: CanonicalUri): void {
      const syncedDocument = this.__syncedDocuments.get(uri);
      if (syncedDocument === undefined) {
         return;
      }
      this.log(syncedDocument.uri, `Remove synced document: ${syncedDocument.version} (no client left)`);
      // The next open continues the sequence instead of restarting at the
      // reopening client's declared id.
      this.textLedger.record(uri, syncedDocument);
      this.textLedger.clearAuthors(uri);
      const cleanAnnouncement = this.dirtyStateTracker.release(uri);
      this.__syncedDocuments.delete(uri);
      this.__openedVersions.delete(uri);
      this.__sessions.forgetClientVersions(uri);
      // A stage is for a first open; one released unconsumed is stale.
      this.__pendingContent.delete(uri);
      this.documentReleaseScheduler.clearLosses(uri);
      this.documentReleasedEmitter.fire(Object.freeze({ uri }));
      this.handOverRelease(this.toReleasedDocument(uri), cleanAnnouncement);
   }

   /**
    * Call the `DocumentReleaseHandler` slot, and announce a document released
    * dirty clean once the promise it returns settles, which is after the
    * release event. A failure is logged rather than thrown: the store has let
    * go of the document by now, and a throw would abort the transition that
    * released it, a session's close of its other documents included.
    */
   protected handOverRelease(released: ReleasedDocument, cleanAnnouncement: CleanAnnouncement | undefined): void {
      let settled: Promise<void>;
      try {
         // Read here: a lazily built slot whose factory throws throws on this read.
         const handler = this.services.workspace.DocumentReleaseHandler;
         settled =
            handler === undefined
               ? Promise.reject(new Error('no workspace.DocumentReleaseHandler bound'))
               : Promise.resolve(handler.didReleaseDocument(released));
      } catch (err: unknown) {
         settled = Promise.reject(err);
      }
      // Names the text the build holds at the settle, so it follows anything a
      // release listener did meanwhile: none when its build failed or it no
      // longer has the document, since a removal leaves the record on the
      // discarded text.
      const announceClean = (built: boolean): void => {
         if (cleanAnnouncement?.isOwed()) {
            const inBuild = built && this.services.workspace.LangiumDocuments.getDocument(UriUtils.toUri(released.uri)) !== undefined;
            cleanAnnouncement.announce(inBuild ? this.textState(released.uri) : undefined);
         }
      };
      settled.then(
         () => announceClean(true),
         (err: unknown) => {
            // A release skipped at teardown, its peer or its workspace gone, is
            // routine, not a fault to investigate.
            if (isDocumentReleaseSkippedError(err)) {
               this.tracer.with(released.uri).debug(err.message);
            } else {
               this.tracer
                  .with(released.uri)
                  .error(`Release handler failed. ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
            // Left unsettled, a watcher keeps the document dirty though the store answers clean.
            announceClean(false);
         }
      );
   }

   /** `uri` as the `DocumentReleaseHandler` slot receives it. */
   protected toReleasedDocument(uri: CanonicalUri): ReleasedDocument {
      return {
         uri,
         isFor: other => this.documentKey(other) === uri,
         isReclaimed: () => this.isOpenInAnyClient(uri) || this.__syncedDocuments.has(uri)
      };
   }

   public notifyWillSaveTextDocument(event: WillSaveTextDocumentParams): void {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(event.textDocument.uri));
      if (syncedDocument !== undefined) {
         this.__onWillSave.fire(Object.freeze({ document: syncedDocument, reason: event.reason }));
      }
   }

   public notifyWillSaveTextDocumentWaitUntil(
      event: WillSaveTextDocumentParams,
      token: CancellationToken
   ): HandlerResult<TextEdit[], void> {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(event.textDocument.uri));
      if (syncedDocument !== undefined && this.__willSaveWaitUntil) {
         return this.__willSaveWaitUntil(Object.freeze({ document: syncedDocument, reason: event.reason }), token);
      } else {
         return [];
      }
   }

   /**
    * Handle a save the language client reports: fire
    * {@link onDidSaveInLanguageClient}, then announce it on {@link onDidSave}
    * only once the file read back from disk holds the store's current text.
    */
   protected async notifyLanguageClientSave(event: DidSaveTextDocumentParams): Promise<void> {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(event.textDocument.uri));
      if (syncedDocument === undefined) {
         return;
      }
      const uri = syncedDocument.uri;
      this.languageClientSavedEmitter.fire(Object.freeze({ uri }));
      // `onDidSave` tells its listeners that the shared document is on disk.
      // The editor wrote its own buffer, which lags the store while another
      // client's edit is still on its way to it, so only the file says
      // whether that holds. Read it rather than trust the editor: `didSave`
      // carries text only for a client that honours `includeText`, and asking
      // for it means rewriting Langium's initialize answer, which advertises
      // `save` as a Boolean. The read goes through the disk queue and waits on
      // nothing but the provider, so it follows a server save queued
      // meanwhile. A file changed again between the editor's write and this
      // read compares unequal, and the save goes unannounced.
      let onDisk: string | undefined;
      try {
         onDisk = await this.services.workspace.FileSystemTaskQueue.enqueue(uri, () =>
            this.services.workspace.FileSystemProvider.readFile(UriUtils.toUri(uri))
         );
      } catch (err: unknown) {
         this.tracer
            .with(uri)
            .debug(`Editor save not announced: reading the file back failed. ${err instanceof Error ? err.message : String(err)}`);
         return;
      }
      // What the file holds, not what the editor meant to write: an editor
      // that saved older text leaves the document dirty.
      this.setDiskBaseline(uri, onDisk);
      // An editor that saves and then closes releases the document while the
      // read is under way; its save is still a save of the text it held.
      const document = this.__syncedDocuments.get(this.documentKey(uri)) ?? syncedDocument;
      if (onDisk !== document.getText()) {
         this.tracer.with(uri).debug(`Editor save not announced: the file does not hold the text of version ${document.version}`);
         return;
      }
      this.announceSave(document, LANGUAGE_CLIENT_ID);
   }

   /**
    * Announce a save the server made. `event.text`, when given, is what the
    * file now holds, written or found there, and becomes the disk baseline
    * before the save is announced. It lags the store when an edit landed
    * after the save took its text, and the document then stays dirty.
    */
   public notifyDidSaveTextDocument(event: DidSaveTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(event.textDocument.uri));
      if (syncedDocument !== undefined) {
         if (event.text !== undefined) {
            this.setDiskBaseline(syncedDocument.uri, event.text);
         }
         this.announceSave(syncedDocument, clientId);
      }
   }

   /** Fire {@link onDidSave} for `document`, which need not be synced any more. */
   protected announceSave(document: T, clientId: string): void {
      this.log(document.uri, `Saved synced document: ${document.version} by ${this.formatClientId(clientId)}`);
      this.__onDidSave.fire(Object.freeze({ document, clientId }));
   }

   public notifyDidOpenTextDocument(event: DidOpenTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const td = event.textDocument;
      const uri = this.documentKey(td.uri);
      // Before the deferred release is resolved: refused after it, the open
      // would leave a document whose grace it ended with no holder and no timer.
      // A repeat open stays a no-op.
      if (!this.__sessions.isOpenIn(uri, clientId)) {
         this.__sessions.assertCanOpen(clientId);
      }
      this.resolveDeferredRelease(uri, clientId);
      let document = this.__syncedDocuments.get(uri);
      // The client's declared text, never the synced document: staged
      // content this open consumes leaves the two different, and a baseline
      // asserting the client already holds it suppresses the one sync that
      // would deliver it. On an attach, another client may already have
      // changed the synced text, so the baseline is equality-only; a refresh
      // pushing the full text would dirty the file on open.
      if (clientId === LANGUAGE_CLIENT_ID) {
         this.languageClientShadow.addOpen(uri, this.toLanguageClientUri(td.uri), td.version, td.text, document === undefined);
      }
      if (this.isOpenInClient(uri, clientId)) {
         // A repeat open, or the editor's second URI for the file, e.g. a
         // symlink and its real path: the shadow records it so pushes reach it,
         // and nothing re-fires.
         return;
      }
      const existingClients = this.__sessions.clientsOf(uri);
      this.__sessions.addOpen(uri, clientId);
      this.__sessions.setClientVersion(uri, clientId, td.version);
      if (!document) {
         // Use integrity-staged content if available, otherwise the client-provided (disk) text.
         const pendingText = this.consumePendingContent(uri);
         const text = pendingText ?? td.text;
         const source = pendingText ? ', source=pending' : '';
         const version = this.textLedger.openingVersion(uri, text) ?? this.builtRootOpeningVersion(uri, text) ?? td.version;
         this.log(uri, `Open document: Version ${version} by ${this.formatClientId(clientId)} [first client${source}]`);
         document = this.create(uri, td.languageId, version, text);
         this.commitText(uri, document, clientId);
         this.__openedVersions.set(uri, version);
         // The opener's text, not the staged content: a session's open read
         // it from the file, and an editor opened its buffer from there. An
         // editor that opens a buffer it never saved is taken as clean.
         this.dirtyStateTracker.track(uri, document, td.text);
         const toFire = Object.freeze({ document, clientId });
         this.__onDidOpen.fire(toFire);
         this.__onDidChangeContent.fire(toFire);
      } else {
         // An additional client attaches to a document already open by another client.
         this.logClientJoined(uri, clientId, document.version, existingClients);
         this.refreshContent(uri, clientId);
      }
   }

   /**
    * Record `clientId` as an additional holder of a document another client
    * already has open.
    *
    * Unlike the attach branch of {@link notifyDidOpenTextDocument} this does
    * not refresh. That branch re-renders an attaching TEXTUAL view; a client
    * reaching a document through a non-textual route has nothing to re-render,
    * and refreshing per attach turns each into a Langium rebuild and dependent
    * relink cascade.
    *
    * Returns whether a hold was added — `false` when `uri` is not open,
    * `clientId` already holds it, or the document was waiting out the release
    * grace for other clients and was released instead (see
    * {@link resolveDeferredRelease}); the caller then opens it anew.
    */
   attachClient(uri: DocumentUri, clientId: string): boolean {
      const key = this.documentKey(uri);
      if (!this.__syncedDocuments.has(key) || this.isOpenInClient(key, clientId)) {
         return false;
      }
      // Before the deferred release is resolved, as for an open.
      this.__sessions.assertCanOpen(clientId);
      this.resolveDeferredRelease(key, clientId);
      const document = this.__syncedDocuments.get(key);
      if (!document) {
         return false;
      }
      const existingClients = this.__sessions.clientsOf(key);
      this.__sessions.addOpen(key, clientId);
      // A client arriving this way holds no buffer of its own, so its guard
      // starts at the synced version.
      this.__sessions.setClientVersion(key, clientId, document.version);
      this.logClientJoined(key, clientId, document.version, existingClients);
      return true;
   }

   protected logClientJoined(uri: DocumentUri, clientId: string, version: number, existingClients: readonly string[]): void {
      this.log(
         uri,
         `Attach client: ${this.formatClientId(clientId)} joined existing document (version ${version}, ` +
            `now open in: ${[...existingClients, clientId].map(id => this.formatClientId(id)).join(', ')})`
      );
   }

   refreshContent(uri: DocumentUri, clientId: string): void {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(uri));
      if (syncedDocument) {
         // Trigger a (re-)build by firing a change event.
         const timer = this.startTimerForUri(
            syncedDocument.uri,
            `Refresh synced document: Version ${syncedDocument.version} by ${this.formatClientId(clientId)}`
         );
         this.__onDidChangeContent.fire(Object.freeze({ document: syncedDocument, clientId }));
         timer.dispose();
      }
   }

   /**
    * The canonical key a document is stored under — the single point this store
    * turns an incoming URI into its identity, the store-side analogue of
    * `DocumentUriPolicy.canonicalUri`. Keying by the CANONICAL identity collapses
    * two URIs for one physical file (a symlink path and its real path) into a
    * single registration — dedup at the editor layer, not just in
    * `LangiumDocuments`. The URI the client opened under is preserved separately
    * for egress addressing, by the {@link LanguageClientShadow}. The
    * policy is always bound (the framework defaults it to
    * `DefaultDocumentUriPolicy`, where canonical ≡ syntactic normalize).
    */
   protected documentKey(uri: string): CanonicalUri {
      return this.services.workspace.DocumentUriPolicy.canonicalUri(uri);
   }

   /**
    * The language-client URI for `uri` — syntactic `normalize` only, NOT
    * canonicalized. This is the URI the LSP textual client (Monaco / VS Code)
    * actually holds the document under (what `applyEditToLanguageClient` must address and
    * what the shadow is keyed by), distinct from {@link documentKey} (the canonical
    * identity the document is stored under). They coincide unless the path diverges
    * from its real path (symlink / `..` / case).
    */
   protected toLanguageClientUri(uri: string): LanguageClientUri {
      return asLanguageClientUri(UriUtils.normalize(uri));
   }

   setAuthor(uri: DocumentUri, version: number, author: string): void {
      this.textLedger.setAuthor(this.documentKey(uri), version, author);
   }

   /**
    * Resolve the synced `TextDocument` for `uri`. The store keys documents by
    * their canonical identity ({@link documentKey}), so a direct normalized hit
    * wins the common case (the caller passes the canonical URI, or the opened URI
    * coincides with it) with no canonicalization, and a miss falls back to the
    * single canonical-key lookup — which is what bridges a client-space caller
    * that addresses a symlinked path `S` to the document the build keys by its
    * real path `R` (`documentKey(S) === R`).
    *
    * O(1): no scan. Because the interior is already canonically keyed, looking the
    * canonical key up directly is equivalent to reverse-matching every entry, and
    * the `super.get` fast path keeps the common case syscall-free (the
    * canonical lookup, and its one `canonicalUri` realpath, runs only on a miss).
    * Under the default policy `documentKey ≡ normalize`, so the fallback can never
    * find a key the direct lookup didn't — `get` is then identical to the base.
    */
   override get(uri: DocumentUri): T | undefined {
      return super.get(uri) ?? this.__syncedDocuments.get(this.documentKey(uri));
   }

   /**
    * Current SHARED version of the document at `uri`: the open document's
    * version, else where its persisted sequence left off, else `0` for a URI
    * this store has never seen. The shared sequence is
    * server-owned and monotonic across close/reopen cycles, and advances
    * exactly when the synced content changes — which is what makes it a sound
    * optimistic-concurrency token (base-version gates): version unchanged ⇔
    * content unchanged.
    */
   version(uri: DocumentUri): TextVersion {
      return this.get(uri)?.version ?? this.textLedger.recordOf(this.documentKey(uri))?.version ?? 0;
   }

   /**
    * The version the document at `uri` was opened at, which a client's write
    * or an integrity repair steps past; `undefined` while it is not open.
    */
   openedVersion(uri: DocumentUri): TextVersion | undefined {
      return this.__openedVersions.get(this.documentKey(uri));
   }

   /**
    * The text the store holds for `uri`: an open document's, or for a closed
    * one, the clean text its version sequence left off at, which for a deleted
    * document is its last text. `undefined` for a URI no build and no client
    * gave the store.
    */
   textState(uri: DocumentUri): TextState | undefined {
      const document = this.get(uri);
      if (document) {
         return { version: document.version, hash: this.textLedger.hashOf(document), dirty: this.isDirty(uri) };
      }
      const recorded = this.textLedger.recordOf(this.documentKey(uri));
      return recorded && { version: recorded.version, hash: recorded.hash, dirty: false };
   }

   /**
    * The built root's recorded version for a first open of `key` with `text`,
    * one on when the text differs from the root's; `undefined` when the root
    * records no store version. Seeded from the opener's declared version
    * instead, a write based on the built root passes the gate over other text,
    * and the same text looks newer than its model. A built root records none
    * only under a `LangiumDocuments` that does not reconcile at registration.
    */
   protected builtRootOpeningVersion(key: CanonicalUri, text: string): TextVersion | undefined {
      const built = this.services.workspace.LangiumDocuments.getDocument(UriUtils.toUri(key));
      if (built === undefined) {
         return undefined;
      }
      const ledger = this.services.workspace.ModelLedger;
      const root = built.parseResult.value;
      const recorded = ledger.versionOf(root);
      if (recorded === UNRECORDED_VERSION || recorded === STALE_VERSION) {
         return undefined;
      }
      return (ledger.textOf(root) ?? built.textDocument.getText()) === text ? recorded : recorded + 1;
   }

   /**
    * Reconcile the persisted version sequence with content that reached the
    * build OUTSIDE the store's write paths — a closed document rebuilt from
    * disk after its release, or replaced by a watched-file change. Steps the
    * sequence iff `text` differs from the sequence's last-known content and
    * returns the resulting sequence version so the caller can re-stamp the
    * rebuilt document (`VersionSyncService.modelProduced`) —
    * keeping the "version advances iff content changes" invariant for
    * documents no client currently holds.
    *
    * For an open document, its version when it holds `text`, since a build
    * that read the file while the document was closed can finish after an
    * open; else `undefined`, and the caller has to build the document again.
    *
    * A document without a sequence starts one at `0` with `text`: snapshots
    * hand out versions for documents no client opened, so an uncounted change
    * would let a write based on the old text pass the gate.
    */
   reconcileExternalContent(uri: DocumentUri, text: string): number | undefined {
      const key = this.documentKey(uri);
      const open = this.__syncedDocuments.get(key);
      if (open !== undefined) {
         return open.getText() === text ? open.version : undefined;
      }
      const before = this.textLedger.recordOf(key)?.version;
      const version = this.textLedger.reconcile(key, text);
      if (before !== undefined && version !== before) {
         this.logUri(key, `External content change while closed: sequence stepped to version ${version}`, 'debug');
      }
      return version;
   }

   /**
    * Commit an integrity repair into the OPEN document for `uri`, returning the
    * document that now holds it, or `undefined` when there was nothing here to
    * commit into.
    *
    * The one thing this exists to do is address the store BY URI. A repair
    * reaches the resync as a text-document object, and that object is the
    * store's own only on the LSP path; a document built for an already-open URI
    * through `LangiumDocumentFactory.fromString` carries its own, so writing the
    * repair into it corrects a copy the store does not know about and the editor
    * never sees.
    *
    * `parsedFrom` is the text the repaired AST was parsed from, and a mismatch
    * against the current content REFUSES the commit: the store has moved on,
    * which means an editor change landed after that parse, and committing would
    * overwrite a newer edit with a repair computed against text the user has
    * already replaced. The build that change provokes recomputes the repair.
    *
    * Deliberately NOT compared by version. A separately created document seeds
    * its own numbering, so requiring the two to agree would refuse every commit
    * on the path this exists for. Content is the thing both sides can be held to.
    *
    * A changed text is a new version authored by {@link INTEGRITY_CLIENT_ID}.
    * Kept at the old version, the repair is invisible to every reader keyed on
    * versions: a write based on the unrepaired version passes the base-version gate
    * and replaces the repair, and an echo filter credits the repair to the
    * client whose edit it corrected. No change event is fired: the repair
    * rides the build already under way, and an event would re-enter it.
    */
   commitRepair(uri: DocumentUri, parsedFrom: string, repaired: string): RepairCommit<T> {
      const key = this.documentKey(uri);
      const document = this.__syncedDocuments.get(key);
      if (document === undefined) {
         return { status: 'not-open' };
      }
      if (document.getText() !== parsedFrom) {
         this.logUri(key, 'Refuse repair commit: the open document moved on from the text the AST was parsed from', 'debug');
         return { status: 'stale' };
      }
      if (repaired === parsedFrom) {
         return { status: 'committed', document };
      }
      // Reassigned rather than mutated in place: the default configuration
      // updates and returns the SAME instance, but an adopter-supplied one may
      // return a new object, and the store must end up holding whichever it is.
      const updated = this.commitChange(key, document, [{ text: repaired }], INTEGRITY_CLIENT_ID).document;
      this.log(updated.uri, `Update to version ${updated.version} by ${this.formatClientId(INTEGRITY_CLIENT_ID)} (repair)`);
      return { status: 'committed', document: updated };
   }

   getAuthor(uri: DocumentUri, version?: number): string | undefined {
      const key = this.documentKey(uri);
      const clientId = this.textLedger.authorOf(key, version);
      if (!clientId && this.textLedger.authorOf(key) !== undefined) {
         // Only warn when there IS a history but the specific version is missing; no history at all
         // means the document was rebuilt internally (e.g. by a project manager), not an error.
         this.log(uri, `Could not detect author of version ${version}.`);
      }
      return clientId;
   }

   isOpen(uri: DocumentUri): boolean {
      return this.__syncedDocuments.has(this.documentKey(uri));
   }

   /**
    * True iff any client still holds `uri` open. Distinct from {@link isOpen},
    * which reads `__syncedDocuments` — that map is cleared only AFTER the
    * `onDidClose` event fires for the last client, so `isOpen` returns `true`
    * during the close event itself. `isOpenInAnyClient` reads the open table
    * ({@link __sessions}), which is updated BEFORE the fire, so an `onDidClose`
    * subscriber that finds this `false` knows the last client just closed.
    * What the build keeps is the release's: a subscriber that re-read or
    * rebuilt the document would race the `DocumentReleaseHandler`, and after a
    * lost connection the release waits out its grace.
    */
   isOpenInAnyClient(uri: DocumentUri): boolean {
      return this.__sessions.isOpen(this.documentKey(uri));
   }

   isOpenInClient(uri: DocumentUri, client: string): boolean {
      return this.__sessions.isOpenIn(this.documentKey(uri), client);
   }

   isOpenInLanguageClient(uri: DocumentUri): boolean {
      // Takes any URI form (canonicalizes internally via `documentKey`, like
      // `isOpen`); the document is keyed canonically, so a canonical or a
      // client-facing URI both resolve to the same registration.
      return this.isOpenInClient(uri, LANGUAGE_CLIENT_ID);
   }

   /** The clients that have `uri` open, in the order they opened it. */
   clientsOf(uri: DocumentUri): string[] {
      return this.__sessions.clientsOf(this.documentKey(uri));
   }

   isOnlyOpenInClient(uri: DocumentUri, client: string): boolean {
      const clients = this.__sessions.clientsOf(this.documentKey(uri));
      return clients.length === 1 && clients[0] === client;
   }

   /**
    * Every document currently held open by at least one client, with the client
    * ids holding it. Reads the same open table as {@link isOpenInAnyClient}, so
    * it reflects a last-client close immediately.
    *
    * Diagnostics-oriented — the server-state snapshot lists these so an operator
    * can see WHY a document is pinned: a document that lingers here after its
    * editor closed points directly at the client that failed to close it (and,
    * under a shedding policy, explains why its CST is never shed).
    */
   openDocuments(): OpenDocument[] {
      return this.__sessions.openDocuments();
   }

   /** Fires once a client session has ended, after every document it had open was closed. */
   get onDidCloseSession(): Event<ClientSessionClosedEvent> {
      return this.__sessions.onDidCloseSession;
   }

   /**
    * Fires once a document no client has open is released: at its last close,
    * or, for a lost client's last close, when its release grace runs out,
    * another client opens it, or it is deleted, before the
    * `DocumentReleaseHandler` slot is handed the document.
    */
   get onDidReleaseDocument(): Event<DocumentReleasedEvent> {
      return this.documentReleasedEmitter.event;
   }

   /**
    * Fires for every save the language client reports of a document it has
    * open: the editor has written the file. {@link onDidSave} follows only
    * when the file holds the store's text.
    */
   get onDidSaveInLanguageClient(): Event<LanguageClientSavedEvent> {
      return this.languageClientSavedEmitter.event;
   }

   /**
    * Whether `uri` is waiting out the release grace: its last open closed with a
    * lost connection, and it still holds its unsaved text. Such a document is
    * open for no client, yet not closed either, so a caller that would persist
    * a closed document's text to disk treats it as open.
    */
   isReleaseDeferred(uri: DocumentUri): boolean {
      return this.documentReleaseScheduler.isDeferred(this.documentKey(uri));
   }

   /**
    * Whether the store holds `uri` with text that differs from its disk
    * baseline: what the server last knew the file to hold. `false` for a URI
    * the store does not hold; a document waiting out the release grace is still
    * held.
    *
    * The baseline is the text a first open brought, or what the server wrote,
    * or read back after an editor's save or a watched-file change, so it can
    * trail a change to the file that none of these has seen yet. A check that
    * must know the file reads it instead.
    */
   isDirty(uri: DocumentUri): boolean {
      return this.dirtyStateTracker.isDirty(this.documentKey(uri));
   }

   /**
    * Fires each time the answer of {@link isDirty} changes. For a document
    * released dirty it fires once the `DocumentReleaseHandler` slot reports the
    * release settled: at the version of the text the build then holds, or
    * without text when the document is gone or the handler failed, though
    * {@link isDirty} answers clean from the release on.
    */
   get onDidChangeDirty(): Event<DocumentDirtyChangedEvent> {
      return this.dirtyStateTracker.onDidChangeDirty;
   }

   /**
    * Record that the file behind `uri` holds `text`, or no file at all for
    * `undefined`. A no-op for a URI the store does not hold: the next first
    * open sets the baseline from its own text.
    */
   setDiskBaseline(uri: DocumentUri, text: string | undefined): void {
      const key = this.documentKey(uri);
      const document = this.__syncedDocuments.get(key);
      if (document !== undefined) {
         this.dirtyStateTracker.setDiskBaseline(key, document, text);
      }
   }

   /**
    * Read the file behind `uri` through its disk queue and take it as the
    * baseline. A file that cannot be read counts as none, the side that
    * leaves the document dirty.
    */
   async reloadDiskBaseline(uri: DocumentUri): Promise<void> {
      const key = this.documentKey(uri);
      if (!this.__syncedDocuments.has(key)) {
         return;
      }
      let onDisk: string | undefined;
      try {
         onDisk = await this.services.workspace.FileSystemTaskQueue.enqueue(key, () =>
            this.services.workspace.FileSystemProvider.readFile(UriUtils.toUri(key))
         );
      } catch (err: unknown) {
         this.tracer.with(key).debug(`Disk baseline: the file cannot be read. ${err instanceof Error ? err.message : String(err)}`);
      }
      this.setDiskBaseline(key, onDisk);
   }

   /**
    * Start a client session under `clientId`. Throws where
    * {@link ClientSessionRegistry.register} refuses the id.
    */
   registerSession(clientId: string): void {
      this.__sessions.register(clientId);
      this.tracer.info(`Session started: ${this.formatClientId(clientId)}`);
      this.tracer.trace(`Session started: ${clientId}`);
   }

   /**
    * End the client session `clientId`: close every document it has open, then
    * free the id. Immediate — each close runs the ordinary close path before
    * this returns, with `cause` as its cause. A no-op for an id that is not a
    * registered session.
    */
   closeSession(clientId: string, cause: SessionEndCause = 'closed'): void {
      if (!this.__sessions.isRegistered(clientId)) {
         return;
      }
      try {
         for (const uri of this.__sessions.beginClose(clientId)) {
            this.notifyDidCloseTextDocument({ textDocument: { uri } }, clientId, cause);
         }
      } finally {
         this.__sessions.unregister(clientId, cause);
         this.tracer.info(`Session closed: ${this.formatClientId(clientId)}`);
         this.tracer.trace(`Session closed: ${clientId}`);
      }
   }

   /**
    * Close every document the language client has open, as a `didClose` for
    * each would, so each last close releases its document. For a host whose editor connection
    * can end while the process lives on, such as a worker whose port's peer
    * closed: the language client is no session, so nothing else closes them.
    *
    * It first waits for the workspace initialization the open handler waits
    * for, so an open that arrived before the close is closed too; closing at
    * once would leave that open to land afterwards, held by a client that is
    * gone.
    */
   async closeLanguageClientDocuments(): Promise<void> {
      await this.initialBuildFinished();
      for (const uri of this.__sessions.opensOf(LANGUAGE_CLIENT_ID)) {
         // A close for one URI while others remain keeps the client's hold.
         this.languageClientShadow.removeAllOpens(uri);
         this.notifyDidCloseTextDocument({ textDocument: { uri } });
      }
   }

   /**
    * Settles once the initial workspace build has finished, whether it
    * completed, was cancelled or failed. Awaiting `workspaceInitialized` itself
    * throws after a cancelled build, which any write during startup causes, and
    * every open and close gated on it is then dropped for the process lifetime.
    * The workspace manager logs a failed build.
    */
   protected async initialBuildFinished(): Promise<void> {
      await this.services.workspace.WorkspaceManager.workspaceInitialized.catch(() => undefined);
   }

   /**
    * The file behind `uri` was deleted: close every open of it except the
    * language client's.
    *
    * The editor's open is left alone because the editor owns it: it keeps the
    * buffer of a deleted file and goes on sending changes for it, and a store
    * that had closed the document would drop every one of them until the editor
    * reopened.
    */
   notifyDocumentDeleted(uri: DocumentUri): void {
      const key = this.documentKey(uri);
      for (const clientId of this.__sessions.clientsOf(key)) {
         if (clientId !== LANGUAGE_CLIENT_ID) {
            this.notifyDidCloseTextDocument({ textDocument: { uri: key } }, clientId);
         }
      }
   }

   /**
    * Remove the document for `uri`, closing every open of it first — the
    * editor's included, since the document it would keep editing is gone.
    *
    * The base removes the synced document without consulting the open table,
    * which leaves every open recorded against a document that no longer exists:
    * the store then answers that the URI is open, and the next open attaches to
    * nothing.
    */
   override delete(uri: string | URI | T): void {
      const key = this.documentKey((typeof uri === 'object' && 'uri' in uri ? uri.uri : uri).toString());
      this.languageClientShadow.removeAllOpens(key);
      for (const clientId of this.__sessions.clientsOf(key)) {
         this.notifyDidCloseTextDocument({ textDocument: { uri: key } }, clientId);
      }
      // A document waiting out the grace has no client left to close, and is
      // released now as its last close would have released it.
      if (this.documentReleaseScheduler.isDeferred(key)) {
         this.documentReleaseScheduler.cancel(key);
         this.releaseDocument(key);
      }
      super.delete(key);
   }

   /**
    * A client id as log lines print it. An id containing `#` is cut eight
    * characters after its last `#`, which leaves a minted `label#uuid` as the
    * label and enough of the UUID to tell sessions apart; an id without `#`
    * prints whole. The full id goes out at trace level wherever a session
    * starts or ends.
    */
   protected formatClientId(clientId: string): string {
      const separator = clientId.lastIndexOf('#');
      return separator < 0 ? clientId : clientId.slice(0, separator + 9);
   }

   /**
    * Stages integrity-updated content for a document no client holds.
    *
    * Nothing is pushed to a file no client holds. The next open of it reads
    * disk, which lacks the update; {@link notifyDidOpenTextDocument} takes this
    * staged content in place of that text, and the open's sync then delivers
    * it to an editor as an unsaved change.
    *
    * Only a FIRST open consumes it, so stage only for a URI no client holds
    * ({@link isOpenInAnyClient} is `false`). A URI held only through another
    * head is not closed: an editor attaching to it joins the existing entry and
    * never reads the stage, and the release discards it. An entry waits for
    * that first open, at one serialised string per URI.
    */
   stagePendingContent(uri: DocumentUri, text: string): void {
      this.__pendingContent.set(this.documentKey(uri), text);
   }

   /**
    * Send `newText` to the LSP textual language client (Monaco / VS Code) via
    * `workspace/applyEdit`, using the tracked shadow to produce minimal
    * `TextEdit`s instead of a full-document replace.
    *
    * Returns `undefined` when:
    *   - The shared services have no LSP {@link Connection} bound (non-LSP
    *     hosts like CLI / tests).
    *   - The shadow already matches `newText` (no edits needed; quiet skip).
    *   - The language client has not opened the document. A client applies an
    *     edit to a closed file by opening it, and that open races the edit;
    *     the document's own open delivers its text instead.
    *
    * On `applyEdit` rejection (`result.applied === false`) or RPC failure the
    * shadow is invalidated so the next call sends a full replace, or nothing
    * when the client was last heard to hold that text.
    * Errors are re-thrown — callers wrap with their own retry / coalescing
    * policy as needed.
    *
    * The diff path is apply-verify-safe: the shadow internally checks that
    * `TextDocument.applyEdits(old, edits) === newText` and falls back to a
    * full replace on mismatch, logged, so a diff regression becomes log noise,
    * not data loss.
    *
    * That safety net verifies the diff against the SHADOW, which is what the
    * client is *believed* to hold — so it cannot see the client's buffer moving
    * underneath a push. A line-keyed edit is position-dependent: if a genuine
    * client keystroke lands between computing the edits and the client
    * applying them, the ranges address the wrong lines and splice the buffer
    * (observed as a duplicated declaration, which the integrity tier then
    * "repairs" into a suffixed name and persists). The edit is therefore
    * addressed at the language client's last known version for that URI rather
    * than at `null` ("version intentionally unknown"), which is what lets the
    * client reject a push its buffer has outrun. On rejection the shadow is invalidated,
    * so the caller's retry is a full-range replace — position-independent, and
    * safe to apply to whatever the client now holds — or nothing when the
    * client was last heard to hold that text.
    */
   async applyEditToLanguageClient(
      uri: DocumentUri,
      newText: string,
      options?: { label?: string }
   ): Promise<ApplyWorkspaceEditResult | undefined> {
      const connection = this.services.lsp?.Connection;
      if (!connection) {
         return undefined;
      }
      // The document is keyed by its canonical identity, but the client holds it
      // under each URI it opened, and each is diffed against its own baseline.
      const key = this.documentKey(uri);
      let lastResult: ApplyWorkspaceEditResult | undefined;
      for (const clientUri of this.languageClientShadow.pushTargets(key)) {
         // Prepared per target, after the previous target's reply: prepared up
         // front, a later target is diffed against what it held before a change
         // that arrived meanwhile.
         const push = this.languageClientShadow.preparePush(key, clientUri, newText);
         if (push === undefined) {
            continue;
         }
         try {
            // A full `ApplyWorkspaceEditParams`, `edit` and all — NOT a bare
            // `WorkspaceEdit` with a `label` beside it. `applyEdit` takes
            // `ApplyWorkspaceEditParams | WorkspaceEdit` and discriminates on
            // `!!value.edit`, so `{ label, documentChanges }` is wrapped as
            // `{ edit: { label, documentChanges } }` — putting the label inside
            // the edit, where LSP defines no such field and no client reads it.
            // The union is also what hides it at compile time: excess-property
            // checking admits a property present in EITHER member, so an object
            // matching neither type-checks against the union.
            const version = push.version ?? UNKNOWN_CLIENT_VERSION;
            const result = await connection.workspace.applyEdit({
               label: options?.label,
               edit: {
                  documentChanges: [TextDocumentEdit.create(OptionalVersionedTextDocumentIdentifier.create(clientUri, version), push.edits)]
               }
            });
            if (result && result.applied === false) {
               push.notifyOutcome('refused');
            } else if (result?.applied) {
               push.notifyOutcome('applied');
            }
            lastResult = result;
         } catch (err: unknown) {
            push.notifyOutcome('failed');
            throw err;
         }
      }
      return lastResult;
   }

   /**
    * Explicitly baseline the language-client shadow for a URI the client has
    * open, for an adopter that knows what the client holds without a
    * `didChange` saying so (e.g. after a sideband save). Normal didOpen /
    * didChange paths from the LSP language client already auto-track the
    * shadow. A seed for a URI the client has not opened is kept but changes no
    * push, since nothing is pushed there; its open replaces it with the text it
    * declares.
    */
   setLanguageClientText(uri: DocumentUri, text: string): void {
      this.languageClientShadow.setClientText(this.toLanguageClientUri(uri), text);
   }

   /**
    * Drop the shadow baseline for a URI; the next applyEditToLanguageClient
    * sends a full replace, or nothing when the client was last heard to hold
    * that text.
    */
   invalidateLanguageClientText(uri: DocumentUri): void {
      this.languageClientShadow.invalidateClientText(this.toLanguageClientUri(uri));
   }

   protected consumePendingContent(uri: DocumentUri): string | undefined {
      const key = this.documentKey(uri);
      const content = this.__pendingContent.get(key);
      this.__pendingContent.delete(key);
      return content;
   }

   protected log(uri: DocumentUri, message: string): void {
      this.logUri(uri, message, 'info');
   }

   /** Hook for subclasses that want to attach a workspace-relative path component. */
   protected logUri(uri: DocumentUri, message: string, level: 'info' | 'debug' = 'info'): void {
      this.tracer.with(uri)[level](message);
   }

   /** Hook for subclasses that want a URI-tagged timer. */
   protected startTimerForUri(uri: DocumentUri, message: string): { dispose(): void } {
      return this.tracer.with(uri).startTimer(message);
   }
}
