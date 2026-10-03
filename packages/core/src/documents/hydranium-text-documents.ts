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
   TextDocumentContentChangeEvent as ContentChange,
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
   type Stopwatch,
   type TextState,
   type TextVersion,
   textHash,
   type Tracer,
   STALE_VERSION,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { HYDRANIUM_BUILD_REASONS } from '../langium/document-builder/document-builder.js';
import { isConnectionGoneError } from '../util/connection-liveness.js';
import { LANGUAGE_CLIENT_ID } from './client-ids.js';
import { INTEGRITY_CLIENT_ID } from '../langium/integrity/integrity-rule.js';
import { type ClientSessionClosedEvent, ClientSessionRegistry, type SessionEndCause } from './client-session-registry.js';
import { isFullReplace, LanguageClientTextShadow } from './language-client-text-shadow.js';

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
    * connection was lost keeps its text before it reverts to disk. An open by
    * a client lost from the document, within this time of its own loss,
    * cancels the revert, so a client that registers again under its id after
    * a dropped connection finds its unsaved edits. Any other open releases the
    * document first and then opens it as a first open does, from the text the
    * opener supplies (an editor's own) or else from the file. Meanwhile the
    * document counts as open for the integrity service, which therefore writes
    * none of its unsaved text to disk. A close the client makes itself, or
    * ending its session, reverts at once whatever this is.
    *
    * Defaults to 10 s. `0` reverts such a document at once as well, released
    * in the close itself rather than on a timer.
    */
   readonly revertGraceMs?: number;
}

/**
 * The default of {@link HydraniumTextDocumentsOptions.revertGraceMs}: long
 * enough for a client whose connection dropped to register again and reopen
 * its documents, which a data client does as soon as it has a connection.
 */
const DEFAULT_REVERT_GRACE_MS = 10_000;

/** Delivered by {@link HydraniumTextDocuments.onDidSaveInLanguageClient}. */
export interface LanguageClientSavedEvent {
   readonly uri: string;
}

/** Delivered by {@link HydraniumTextDocuments.onDidCloseLastOpen}. */
export interface LastOpenClosedEvent {
   readonly uri: CanonicalUri;
}

/** Delivered by {@link HydraniumTextDocuments.onDidChangeDirty}. */
export interface DocumentDirtyChangedEvent {
   readonly uri: CanonicalUri;
   /**
    * The text the new answer of {@link HydraniumTextDocuments.isDirty} was
    * decided on. The answer changes with the text, before any build, so it can
    * name text whose model has not been sent yet. Absent when the document no
    * longer exists, or when the build that follows its release failed.
    */
   readonly text?: TextState;
}

/**
 * The language client's open of a document under one URI, from its didOpen to
 * its didClose. Each URI is its own editor buffer with its own version counter,
 * so a file reached through a symlink and its real path has one of these each.
 */
export interface LanguageClientDocumentState {
   /** The version the client last declared for this URI. */
   declaredVersion: number;
   /**
    * The version an applied versioned push moved this URI to, ahead of its
    * echo. Apart from `declaredVersion`, whose staleness guard would drop that
    * echo and strand its pending push.
    */
   pushedVersion?: number;
}

/**
 * All per-URI client-facing tracking the manager keys by normalized URI,
 * collapsed into one record so a URI's full state lives in one place and the
 * last-client close clears every axis in a single delete. (Parallel per-axis
 * maps are the substrate of a close-on-stale-state desync — one map can be
 * cleared while another lingers.)
 *
 * Two neighbours deliberately stay separate:
 *  - The inherited `__syncedDocuments` (Langium's parsed `TextDocument` store).
 *  - {@link LanguageClientTextShadow} (`__shadow`), a self-contained,
 *    separately-tested diff/apply-verify abstraction that owns its own baseline
 *    text; folding its storage here would couple a clean utility to this record
 *    for no real gain.
 *
 * Returned by the `protected` {@link HydraniumTextDocuments.trackingFor}, so an
 * override has to name it. Restating the shape structurally instead compiles
 * until a field is added here, and then fails at the adopter rather than at the
 * change that caused it.
 */
export interface DocumentTrackingRecord {
   /** Author of each version, sparse-indexed by the SHARED (server-assigned) version number. */
   readonly versionAuthors: string[];
   /**
    * Last version id each client declared for this document (didOpen baseline,
    * advanced by every accepted didChange), for the per-client staleness guard.
    * Client version ids are CLIENT-owned per LSP (Monaco numbers its own
    * buffer) — they never leak into the shared version sequence, which the
    * server assigns (see {@link HydraniumTextDocuments.__versionSequences}).
    * The language client's entry is the latest any of its URIs declared; the
    * store checks and addresses it per URI, through
    * {@link DocumentTrackingRecord.languageClientDocuments}.
    */
   readonly clientVersions: Map<string, number>;
   /** Content staged by integrity rules for a closed document. Consumed on next open. */
   pendingContent?: string;
   /**
    * Each URI the LSP textual language client opened this (canonically-keyed)
    * document under, with that open's state. Usually one; more when the same
    * file is opened under a symlink path and its real path. These are the
    * egress addresses: the document is *keyed* by its canonical identity, but
    * Monaco holds it under the URI it opened. The language client holds the
    * document while any entry remains.
    */
   languageClientDocuments?: Map<LanguageClientUri, LanguageClientDocumentState>;
   /**
    * The clients whose close of this document was caused by a lost connection
    * and that have not opened it again, each with a stopwatch started at its
    * loss on the store's `Clock`. While the document waits out the revert grace, only an
    * open by one of them within its own
    * {@link HydraniumTextDocumentsOptions.revertGraceMs} of that loss cancels
    * the revert. Every such client counts, not only the last to close: one
    * connection's sessions all end lost together, and any of them may reopen
    * first. Without the time limit, a client that returns late inherits the
    * unsaved text of a holder lost after it. A stopwatch rather than a `now()`
    * reading, because a wall-clock step would otherwise expire a claim early or
    * revive one past its grace, against a grace timer that the step leaves
    * alone. An entry past its grace counts as any other client's and is pruned
    * at the next open of the document.
    */
   lostClients?: Map<string, Stopwatch>;
   /**
    * The text the server last knew the file to hold, `undefined` for no file.
    * Set by the first open and moved by {@link HydraniumTextDocuments.updateDiskBaseline}.
    */
   diskBaseline?: string;
   /** The last answer {@link HydraniumTextDocuments.onDidChangeDirty} announced. */
   dirty?: boolean;
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
 * Where a URI's shared version sequence left off while no client holds it —
 * started by its first build, stepped by builds of changed text, written at
 * last-client close, and consulted at the next open so the sequence CONTINUES
 * instead of restarting at whatever version id the opening client declares. One entry
 * of {@link HydraniumTextDocuments.__versionSequences} — a `protected` field, so
 * a subclass reading the map has to name what it holds.
 */
export interface VersionSequence {
   /** The shared version of the text last closed or built. */
   readonly version: number;
   /** {@link textHash} of that text. */
   readonly contentHash: string;
}

/**
 * Upper bound on {@link HydraniumTextDocuments.__pendingPushes} entries
 * per URI. Echoes normally return within milliseconds and consume their
 * entry; a queue this deep means the client stopped echoing — cap instead
 * of leaking.
 */
const PENDING_ECHO_CAP = 32;

/**
 * The one field of `vscode-languageserver`'s `Connection` this class has to
 * reach that its public type does not declare. Named here rather than cast
 * inline so the write states which shape it assumes.
 */
interface ConnectionWithTextDocumentSync {
   __textDocumentSync?: TextDocumentSyncKind;
}

/**
 * One text pushed to the LSP textual language client by
 * {@link HydraniumTextDocuments.applyEditToLanguageClient} whose echo has not
 * come back yet. One entry of {@link HydraniumTextDocuments.__pendingPushes} —
 * a `protected` field, so a subclass reading the queue has to name what it holds.
 */
export interface PendingLanguageClientPush {
   /**
    * The text the client held BEFORE this push, and therefore the text its
    * echo addresses with its ranges. Wider than the baseline the push's edits
    * were diffed against: a full replace is sent with no diff baseline and
    * still lands on a buffer the echo is keyed to.
    *
    * `undefined` only when that buffer is unknown — the client never declared
    * one, or a rejection invalidated what was tracked. The echo is then
    * reconstructed against the synced text, which is sound only for a
    * position-independent (full-text) change.
    */
   readonly before: string | undefined;
   /** {@link textHash} of the text this push moves the client to. */
   readonly afterHash: string;
}

/**
 * What an incoming language-client change turns out to be once reconstructed
 * against the buffer its ranges address — the return of
 * {@link HydraniumTextDocuments.classifyLanguageClientChange}. That method is
 * `protected`, so an override has to name every arm it can return.
 */
export type LanguageClientChangeOrigin =
   /** The client is reporting a text we pushed it. The synced document is already there. */
   | { readonly kind: 'echo' }
   /**
    * The client's buffer holds a text we did not push it — a keystroke that
    * raced a push, or an edit to a buffer the store has already been written
    * past. The reconstructed text is what it now holds, and is authoritative.
    */
   | { readonly kind: 'divergent'; readonly text: string }
   /**
    * The change carries ranges and no known text addresses them, so no
    * reconstruction is offered. Adopting one anyway splices the document and
    * stores an edit nobody made; dropping costs at most the one keystroke the
    * client still holds and the next push contradicts.
    */
   | { readonly kind: 'unreconstructable' };

/**
 * Whether `err` reports that the file of `target` does not exist, as a Node
 * file system and the framework's providers do: code `ENOENT`, with `target`'s
 * path. A missing file of another document is a different failure.
 */
function isFileNotFound(err: unknown, target: URI): boolean {
   if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'ENOENT') {
      return false;
   }
   return !('path' in err) || err.path === target.fsPath;
}

/**
 * Multi-client text-document tracking on top of Langium's `NormalizedTextDocuments`.
 *
 * Adds the framework features used by the integrity, model-server, and GLSP layers:
 *   - Per-document client membership (multiple clients can attach to the same
 *     URI) and the client-session table, both kept by {@link __sessions}.
 *   - A SERVER-OWNED shared version sequence: per-URI, monotonic across
 *     close/reopen cycles, advancing exactly when the synced content changes.
 *     Client-declared version ids (Monaco's buffer numbering) feed only a
 *     per-client staleness guard and never leak into a running sequence —
 *     the two are different things (an editor's edit-operation counter vs the
 *     document's content-revision number), and splicing them lets versions drift
 *     silently past base-version gate holders. A URI with no sequence, and no
 *     root that records a version, starts at its opener's declared id: no version
 *     was handed out for it.
 *   - Version-author history so each edit is attributable to its originating client.
 *   - The revert to disk once no client has a document open, for every head
 *     ({@link revertToDisk}), deferred by
 *     {@link HydraniumTextDocumentsOptions.revertGraceMs} after a lost connection.
 *   - A disk baseline per open document, and whether its text differs from it
 *     ({@link isDirty}).
 *   - Pending-content staging used by the integrity service to thread corrections
 *     through `workspace/applyEdit` cycles for currently-closed documents.
 *   - `didOpen` notifications arriving over the LSP connection wait on the
 *     workspace-ready promise, so a client's first open cannot race workspace
 *     discovery. Direct {@link notifyDidOpenTextDocument} calls (the non-LSP
 *     heads) do not pass that gate — their caller owns the ordering.
 */
export class HydraniumTextDocuments<T extends TextDocument = TextDocument> extends NormalizedTextDocuments<T> {
   /**
    * Per-URI client-facing tracking ({@link DocumentTrackingRecord}), keyed by
    * canonical URI. One record per URI, so dropping it clears every axis at
    * once. Which client has the document open is kept apart, in
    * {@link __sessions}.
    */
   protected __documents = new Map<CanonicalUri, DocumentTrackingRecord>();

   /**
    * Which client has which document open, and which client ids are registered
    * sessions. Every open-state predicate on this class reads it, so an open
    * recorded anywhere else is invisible to the last-close transition.
    */
   protected readonly __sessions = new ClientSessionRegistry();

   /**
    * Per-URI shared-version continuity across close/reopen cycles
    * ({@link VersionSequence}), kept for every document a build or a client
    * gave the store, and consulted by the next first-client open. A URI
    * with none, and no root that records a version, starts at its opener's
    * declared version.
    * DELIBERATELY outside {@link DocumentTrackingRecord}: that record is deleted on last close, while the version sequence must
    * survive it — the shared version is a server-owned, monotonic,
    * advances-iff-content-changes counter that never resets while the server
    * lives. That invariant is what makes an optimistic base-version gate
    * sound: "version unchanged ⇔ content unchanged", with no false conflicts
    * from close/reopen version resets and no false passes from a reopened
    * sequence coincidentally landing on a stale writer's number.
    *
    * Never pruned, not even when the file is deleted: a recreated file
    * restarting at `0` would let a write based on the deleted text pass. Two
    * small values per URI ever built, however often it changes.
    */
   protected readonly __versionSequences = new Map<CanonicalUri, VersionSequence>();

   /**
    * Released documents last announced dirty. Their clean flip waits for the
    * revert, so it carries the reverted text's version; a first open before the
    * revert takes the entry over, and its own dirty answer decides the flip.
    * Each release enters a token of its own, so the revert of an earlier
    * release cannot announce a later one clean before that one's revert.
    */
   protected readonly __releasedDirty = new Map<CanonicalUri, object>();

   /** Per held document, the {@link textHash} of its text at the version it was taken. */
   protected readonly __textHashes = new WeakMap<TextDocument, { readonly version: number; readonly hash: string }>();

   /**
    * Texts pushed to the LSP textual language client via
    * {@link applyEditToLanguageClient} whose echoes have not come back yet
    * ({@link PendingLanguageClientPush}), keyed like the shadow by language-client URI.
    * Outbound pushes and inbound echoes are uncorrelated on the wire; this
    * FIFO is the explicit correlation, and it is what
    * {@link classifyLanguageClientChange} reconstructs against.
    *
    * **Each entry keeps the client's PRE-push text, not only a hash of the
    * post-push one.** A hash alone can classify a full-text echo, whose
    * application is a no-op either way — and that is all it ever classified,
    * because a conforming client echoes INCREMENTAL ranges keyed to its
    * previous buffer. Those ranges cannot be applied to the synced text (which
    * the authored write already advanced) and cannot be reconstructed without
    * the baseline: the line they insert lands twice, validates cleanly, and
    * compounds on every later edit.
    *
    * Lifecycle: entries are consumed by the matching echo (together with any
    * older entries it supersedes), and the whole queue drops when the client
    * stops being a pure mirror — a divergent change, an `applyEdit`
    * failure/rejection (shadow invalidation), a close, or an explicit
    * shadow (re)baseline. {@link PENDING_ECHO_CAP} bounds the queue against
    * a pathological echo that never arrives; the memory cost until then is
    * one pre-push text per in-flight push, for milliseconds.
    */
   protected readonly __pendingPushes = new Map<LanguageClientUri, PendingLanguageClientPush[]>();

   /**
    * Tracked text content per URI for the LSP textual language client (Monaco / VS Code).
    * Owned here so {@link applyEditToLanguageClient} can compute minimal `workspace/applyEdit`
    * diffs instead of full-document replaces (5–20 s → <500 ms on 20-30 KB YAML diagrams).
    *
    * Auto-tracked from the multi-client text-document events: open / change / close of
    * the language client (re)baseline or invalidate the shadow. Other client ids
    * (form editor, GLSP, integrity) do NOT touch the shadow — only what Monaco believes
    * it has matters for the diff.
    *
    * Apply-verify safety net is built in: if the diff doesn't reconstruct `newText`
    * exactly, {@link LanguageClientTextShadow.computeEdits} falls back to a full-range
    * replace and invokes the `onFallback` callback — a diff regression becomes log
    * noise, not a 0-byte save.
    *
    * Assigned in the constructor body so the `onFallback` callback can capture
    * `this.logger` after the parameter-property assignment has run (field
    * initializers fire BEFORE parameter-property assignment in TS).
    */
   protected readonly __shadow: LanguageClientTextShadow;

   protected readonly tracer: Tracer;
   protected readonly configuration: TextDocumentsConfiguration<T>;
   /** See {@link HydraniumTextDocumentsOptions.revertGraceMs}. */
   protected readonly revertGraceMs: number;
   protected readonly lastOpenClosedEmitter = new Emitter<LastOpenClosedEvent>();
   protected readonly languageClientSavedEmitter = new Emitter<LanguageClientSavedEvent>();
   protected readonly dirtyChangedEmitter = new Emitter<DocumentDirtyChangedEvent>();

   constructor(
      protected services: ServerSharedServices,
      options: HydraniumTextDocumentsOptions<T> = {}
   ) {
      const configuration = options.configuration ?? (TextDocument as unknown as TextDocumentsConfiguration<T>);
      super(configuration);
      this.configuration = configuration;
      this.tracer = services.Tracer.for(options.logName ?? 'TextDocuments').trace('instantiated');
      this.__shadow = new LanguageClientTextShadow(
         (uri, reason) => this.tracer.with(uri).warn(`Diff apply-verify fallback (${reason}) — using full-document replace`),
         this
      );
      this.revertGraceMs = options.revertGraceMs ?? DEFAULT_REVERT_GRACE_MS;
      this.onDidCloseLastOpen(event => void this.revertToDisk(event.uri));
   }

   // Re-exposed configuration factories — for framework-internal callers
   // (LanguageClientTextShadow's apply-verify probe; IntegrityService.resyncDocument)
   // that need to materialise documents outside the canonical didOpen/didChange flow
   // and must respect the adopter's custom text-document type.

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
         // Per-client staleness guard: client version ids are CLIENT-owned per
         // LSP (Monaco numbers its own buffer), so an incoming id is compared
         // against THAT client's last declared id — never against the shared
         // version, which the server assigns and which routinely runs ahead of
         // a client's ids (authored ModelService writes advance it without the
         // client knowing). Gating on the shared version drops real edits in
         // exactly that lag window. A client with no baseline (never opened —
         // a protocol anomaly) falls back to the shared-version compare, the
         // conservative answer. The language client is checked per URI: each is
         // its own buffer, and one URI's higher id would drop the other's edits.
         const record = this.trackingFor(uri);
         const languageClientDocument =
            clientId === LANGUAGE_CLIENT_ID ? record.languageClientDocuments?.get(this.toLanguageClientUri(td.uri)) : undefined;
         const lastSeen = languageClientDocument?.declaredVersion ?? record.clientVersions.get(clientId) ?? document.version;
         if (lastSeen >= td.version) {
            // Distinguish "already at this version" (common: an echo from the client that triggered
            // the update) from "incoming version older than ours" (stale race).
            const reason =
               lastSeen === td.version ? `already at version ${lastSeen}` : `incoming version ${td.version} older than current ${lastSeen}`;
            this.logUri(uri, `Ignore update by ${this.formatClientId(clientId)}: ${reason}`, 'debug');
            return;
         }
         record.clientVersions.set(clientId, td.version);
         if (languageClientDocument) {
            languageClientDocument.declaredVersion = td.version;
         }

         // A language-client change is keyed to the buffer that client holds,
         // which is the synced text only while the two agree — an authored
         // write advances the synced text without the client knowing, and a
         // push in flight moves the client without the store knowing.
         // Resolve which it is, and against what, before touching anything.
         const origin =
            clientId === LANGUAGE_CLIENT_ID
               ? this.classifyLanguageClientChange(this.toLanguageClientUri(td.uri), document, changes)
               : undefined;
         if (origin?.kind === 'echo') {
            // The client is reporting a text we pushed it, so the synced
            // document is ALREADY there and the changes must not be applied a
            // second time. Nothing is minted and no rebuild fires. The
            // per-client baseline advanced above (the client's ids keep
            // counting); the shadow is deliberately NOT touched — it
            // optimistically tracks the NEWEST pushed text, and dragging it
            // back would make the next outbound diff wrong against what the
            // client actually holds.
            this.logUri(uri, `Skip rebuild: echo of a server-authored push (client version ${td.version})`, 'debug');
            return;
         }
         if (origin?.kind === 'unreconstructable') {
            this.tracer.with(uri).warn(`Drop change: no known client buffer for its ranges (client version ${td.version})`);
            return;
         }

         // The SHARED version advances iff the content actually changes — the
         // invariant optimistic base-version gates rely on. The new text is
         // only known after applying the (possibly incremental) changes, so
         // apply at a tentative +1 and roll the version back on an identical
         // result (an empty-changes update only re-stamps the version).
         //
         // A divergent change is applied as its RECONSTRUCTED text rather than
         // as its own ranges: those ranges address the client's own buffer, so
         // applying them here would splice the wrong lines.
         const previousText = document.getText();
         const sharedVersion = document.version;
         document = this.configuration.update(document, origin === undefined ? changes : [{ text: origin.text }], sharedVersion + 1);
         const changed = document.getText() !== previousText;
         if (!changed) {
            document = this.configuration.update(document, [], sharedVersion);
         }
         this.__syncedDocuments.set(uri, document);
         if (changed) {
            this.setAuthor(uri, document.version, clientId);
            this.refreshDirty(uri);
         }
         if (clientId === LANGUAGE_CLIENT_ID) {
            // Monaco just told us about its new content; record it so the next outbound
            // applyEditToLanguageClient diffs against the right baseline. Keyed by the
            // language-client URI (what Monaco holds), not the canonical document key.
            this.__shadow.set(this.toLanguageClientUri(td.uri), document.getText());
            // Content-identical echo: the language client is echoing text we already had
            // (e.g. Monaco re-emitting a server-pushed applyEditToLanguageClient). The model is
            // unchanged, so skip the rebuild. The per-client baseline + shadow still advanced
            // above so future staleness checks and diffs are correct. Restricted to the
            // language client: a ModelService-authored change is never skipped.
            if (!changed) {
               this.logUri(uri, `Skip rebuild: content unchanged (echo at client version ${td.version})`, 'debug');
               return;
            }
         }
         this.log(
            document.uri,
            `Update to version ${document.version} by ${this.formatClientId(clientId)}${changed ? '' : ' (content unchanged)'}`
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
      let document = this.__syncedDocuments.get(key);
      if (document === undefined) {
         throw new Error(`Document ${uri} is not open for content changes`);
      }
      const changed = document.getText() !== text;
      if (changed) {
         document = this.configuration.update(document, [{ text }], document.version + 1);
         this.__syncedDocuments.set(key, document);
         this.setAuthor(key, document.version, clientId);
         this.refreshDirty(key);
      }
      this.log(
         document.uri,
         `Update to version ${document.version} by ${this.formatClientId(clientId)}${changed ? '' : ' (content unchanged)'}`
      );
      this.__onDidChangeContent.fire(Object.freeze({ document, clientId }));
      return document.version;
   }

   /**
    * Close `clientId`'s open of the document. When it was the last open, the
    * document is released and reverts to disk, at once or, for a `'lost'`
    * close, after {@link HydraniumTextDocumentsOptions.revertGraceMs}.
    */
   public notifyDidCloseTextDocument(
      event: DidCloseTextDocumentParams,
      clientId = LANGUAGE_CLIENT_ID,
      cause: SessionEndCause = 'closed'
   ): void {
      const uri = this.documentKey(event.textDocument.uri);
      if (clientId === LANGUAGE_CLIENT_ID) {
         const clientFacing = this.toLanguageClientUri(event.textDocument.uri);
         const languageClientDocuments = this.__documents.get(uri)?.languageClientDocuments;
         if (languageClientDocuments?.delete(clientFacing) && languageClientDocuments.size > 0) {
            // Another URI still holds the document, so only this one's buffer goes.
            this.__shadow.invalidate(clientFacing);
            this.__pendingPushes.delete(clientFacing);
            return;
         }
      }
      if (!this.__sessions.removeOpen(uri, clientId)) {
         return;
      }
      const record = this.__documents.get(uri);
      record?.clientVersions.delete(clientId);
      if (record && cause === 'lost') {
         (record.lostClients ??= new Map()).set(clientId, this.services.Clock.stopwatch());
      }
      const syncedDocument = this.__syncedDocuments.get(uri);
      if (syncedDocument !== undefined) {
         this.log(syncedDocument.uri, `Closed synced document: ${syncedDocument.version} by ${this.formatClientId(clientId)}`);
         this.__onDidClose.fire(Object.freeze({ document: syncedDocument, clientId }));

         if (clientId === LANGUAGE_CLIENT_ID) {
            // Monaco closed the document; drop the shadow baselined under the URI
            // it held. (If this was the last client the whole record is deleted on
            // release.)
            const droppedUri = this.toLanguageClientUri(event.textDocument.uri);
            this.__shadow.invalidate(droppedUri);
            this.__pendingPushes.delete(droppedUri);
         }
         if (!this.__sessions.isOpen(uri)) {
            if (cause === 'lost' && this.revertGraceMs > 0) {
               this.deferRelease(uri);
            } else {
               this.releaseDocument(uri);
            }
         }
      }
   }

   /**
    * Keep the document, text and all, for the revert grace, then release it.
    * The document stays in the store meanwhile, so a lost client that opens it
    * again within its own grace attaches to it and finds its unsaved text
    * rather than reading disk; see {@link resolvePendingRevert} for any other
    * open.
    */
   protected deferRelease(uri: CanonicalUri): void {
      this.log(uri, `No client left; revert deferred for ${this.revertGraceMs} ms (connection lost)`);
      const timer = this.services.Clock.setTimer(() => {
         this.__sessions.cancelRevert(uri);
         if (!this.__sessions.isOpen(uri)) {
            this.releaseDocument(uri);
         }
      }, this.revertGraceMs);
      this.__sessions.deferRevert(uri, timer);
   }

   /**
    * Resolve the pending revert of `uri` for an open by `clientId`. An open by a
    * client lost from the document within its grace cancels the revert, and
    * the client finds its unsaved text. Any other open releases the document
    * first, so it opens as a first open does: cancelling for every open hands
    * a lost client's unsaved text to whoever opens next, a reloaded page or an
    * editor, with nothing marking it unsaved.
    */
   protected resolvePendingRevert(uri: CanonicalUri, clientId: string): void {
      const record = this.__documents.get(uri);
      if (record) {
         this.pruneLostClients(record);
      }
      const returning = record?.lostClients?.delete(clientId) ?? false;
      if (!this.__sessions.isRevertPending(uri)) {
         return;
      }
      this.__sessions.cancelRevert(uri);
      if (!returning) {
         this.releaseDocument(uri);
      }
   }

   /** Drop the entries of {@link DocumentTrackingRecord.lostClients} whose grace has run out. */
   protected pruneLostClients(record: DocumentTrackingRecord): void {
      for (const [clientId, sinceLoss] of record.lostClients ?? []) {
         if (sinceLoss.elapsedMs >= this.revertGraceMs) {
            record.lostClients?.delete(clientId);
         }
      }
   }

   /**
    * Drop the document no client has open any more, then announce it on
    * {@link onDidCloseLastOpen}, which is what reverts it to disk.
    */
   protected releaseDocument(uri: CanonicalUri): void {
      const syncedDocument = this.__syncedDocuments.get(uri);
      if (syncedDocument === undefined) {
         return;
      }
      this.log(syncedDocument.uri, `Remove synced document: ${syncedDocument.version} (no client left)`);
      // Persist where the shared version sequence left off (version +
      // content hash) so the next open CONTINUES the sequence instead of
      // restarting at the reopening client's declared id. Hashed once
      // here at release, not on every change.
      this.__versionSequences.set(uri, {
         version: syncedDocument.version,
         contentHash: this.heldTextHash(syncedDocument)
      });
      if (this.__documents.get(uri)?.dirty === true) {
         this.__releasedDirty.set(uri, {});
      }
      this.__syncedDocuments.delete(uri);
      // One delete clears every per-URI axis (version history + any staged
      // pending content) so a future open with the same URI starts fresh.
      this.__documents.delete(uri);
      this.lastOpenClosedEmitter.fire(Object.freeze({ uri }));
   }

   /**
    * Rebuild a released document from the file system provider, so the build
    * stops carrying the unsaved text of its last client.
    *
    * The provider decides, for every scheme, by `exists`: a document it can
    * serve is rebuilt from its text, and any other — an editor's `untitled:`
    * buffer, a file never saved, or one deleted meanwhile — is removed
    * from the workspace. A `virtual:` document survives, since the framework's
    * provider for that scheme serves it from the index, whatever provider the
    * host passes as `context.fileSystemProvider`; an edited one therefore keeps
    * its last client's text, and keeping it read-only is the client's job.
    *
    * The answer is read in the document's disk queue, so the rebuild follows
    * any save still queued rather than reverting past it; a file that goes
    * after that read is removed when its rebuild finds none.
    *
    * Whether to revert at all is decided inside the write lock, as its holder:
    * decided before waiting for the lock, a client that opens or re-creates the
    * document meanwhile would have its text rebuilt over, or the document
    * removed. A document some client has open again, or that waits out a new
    * grace, is left to that client.
    *
    * A document released dirty is announced clean, so a watcher is never left
    * holding it dirty: once the revert has parsed the file, even if it is then
    * cancelled, or else once the build it requests in its place has parsed it,
    * as the announcement names the store's text. One the revert or that build
    * removed, or that build failed, is announced without text. A reopen before
    * that takes the announcement over.
    */
   protected async revertToDisk(uri: CanonicalUri): Promise<void> {
      const workspace = this.services.workspace;
      const target = UriUtils.toUri(uri);
      const reopened = (): boolean => this.isOpenInAnyClient(uri) || this.__syncedDocuments.has(uri);
      const releasedDirty = this.__releasedDirty.get(uri);
      const owesFlip = (): boolean => releasedDirty !== undefined && this.__releasedDirty.get(uri) === releasedDirty;
      const announceClean = (withText = true): void => {
         if (owesFlip()) {
            this.__releasedDirty.delete(uri);
            // The sequence of a removed document still names the discarded text.
            const text = !withText || workspace.LangiumDocuments.getDocument(target) === undefined ? undefined : this.textState(uri);
            this.dirtyChangedEmitter.fire(Object.freeze(text ? { uri, text } : { uri }));
         }
      };
      let parsedFromFile = false;
      let parses: Disposable | undefined;
      let onDisk: boolean | undefined;
      let cancelled = false;
      let stopWaiting: (() => void) | undefined;
      // Without it, a revert stopped short leaves the root on the released text.
      const buildInstead = (): void => {
         void workspace.VersionSyncService.requestRecoveryBuild(target, {
            deleted: onDisk === false,
            reason: HYDRANIUM_BUILD_REASONS.didClose,
            // The update handler dropped the change it held back at the release.
            ignoreDeferred: true,
            stillNeeded: () => !reopened()
         }).then(built => {
            if (!built) {
               this.tracer.with(uri).error('Build after a revert that stopped short failed; the store keeps the released text');
               // No parse or removal is coming.
               stopWaiting?.();
               announceClean(false);
            }
         });
      };
      try {
         // Read before the lock: every build and read waits while the lock is
         // held, and this read waits on the file's save I/O.
         onDisk = await workspace.FileSystemTaskQueue.enqueue(uri, () => workspace.FileSystemProvider.exists(target));
         await workspace.WorkspaceManager?.ready;
         // Queuing the write cancels the running build, even when it then reverts nothing.
         if (reopened()) {
            return;
         }
         await workspace.WorkspaceLock.write(async token => {
            if (reopened()) {
               return;
            }
            // Observed rather than awaited: a build cancelled after its parse
            // returns early, and the build it yields to does not parse again.
            parses = workspace.VersionSyncService.onDidRecordModel(document => {
               parsedFromFile ||= this.documentKey(document.uri.toString()) === uri;
            });
            workspace.DocumentBuilder.markNextReason(HYDRANIUM_BUILD_REASONS.didClose);
            // Cleared once the build ends: a cancelled one throws, and the lock resolves.
            cancelled = true;
            try {
               await (onDisk
                  ? workspace.DocumentBuilder.update([target], [], token)
                  : workspace.DocumentBuilder.update([], [target], token));
            } catch (err: unknown) {
               if (!onDisk || !isFileNotFound(err, target)) {
                  throw err;
               }
               // The file went after its existence was read.
               this.tracer.with(uri).debug('Revert found no file; removing the document instead');
               workspace.DocumentBuilder.markNextReason(HYDRANIUM_BUILD_REASONS.didClose);
               await workspace.DocumentBuilder.update([], [target], token);
            }
            cancelled = false;
         });
         // Cancelled before its parse: the write that cancelled it may build nothing.
         if (cancelled && !parsedFromFile && !reopened() && workspace.LangiumDocuments.getDocument(target) !== undefined) {
            buildInstead();
         }
      } catch (err: unknown) {
         // A revert that finishes after the LSP peer went away fails its
         // diagnostics publish, and one that runs after its workspace was torn
         // down finds no file: teardown races, not failed reverts.
         if (isConnectionGoneError(err) || isFileNotFound(err, target)) {
            this.tracer.with(uri).debug(`Revert on last close skipped: ${err instanceof Error ? err.message : String(err)}`);
            return;
         }
         const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
         this.tracer.with(uri).error(`Revert on last close dropped. ${detail}`);
         // The update handler drops a change still debounced at release, so
         // without this build the root stays behind the store's version. A
         // document known to have no file is removed, as the revert would have.
         if (!reopened()) {
            buildInstead();
         }
      } finally {
         parses?.dispose();
         if (parsedFromFile || workspace.LangiumDocuments.getDocument(target) === undefined) {
            announceClean();
         } else if (owesFlip()) {
            // Cancelled before its parse or failed, the revert left the released
            // text in the store: announced now, the clean flip would name it.
            stopWaiting = (): void => {
               parsed.dispose();
               deleted.dispose();
            };
            const done = (): void => {
               stopWaiting?.();
               announceClean();
            };
            const parsed = workspace.VersionSyncService.onDidRecordModel(document => {
               if (this.documentKey(document.uri.toString()) === uri) {
                  done();
               }
            });
            const deleted = workspace.DocumentBuilder.onUpdate((_changed, deletedUris) => {
               if (deletedUris.some(deletedUri => this.documentKey(deletedUri.toString()) === uri)) {
                  done();
               }
            });
         }
      }
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
      this.updateDiskBaseline(uri, onDisk);
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
            this.updateDiskBaseline(syncedDocument.uri, event.text);
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
      this.resolvePendingRevert(uri, clientId);
      if (this.isOpenInClient(uri, clientId)) {
         // Already open for this client under this canonical identity. If this is a
         // NEW client-facing URI for the same file (a second tab reached via a
         // divergent path, e.g. a symlink and its real path), record it so outbound
         // edits reach this tab too — but do NOT re-fire open/rebuild; the document
         // is already live.
         if (clientId === LANGUAGE_CLIENT_ID) {
            const clientFacing = this.toLanguageClientUri(td.uri);
            const record = this.__documents.get(uri);
            if (record && !record.languageClientDocuments?.has(clientFacing)) {
               (record.languageClientDocuments ??= new Map()).set(clientFacing, { declaredVersion: td.version });
               // This tab's own buffer, NOT the synced text: a second tab is a second
               // client model, read from disk, so a server-authored write already
               // applied to the first tab leaves it BEHIND the synced document. Keying
               // a diff to the synced text here addresses lines this tab does not have
               // and drops content it does.
               this.__shadow.setOpenedText(clientFacing, td.text);
            }
         }
         return;
      }
      let document = this.__syncedDocuments.get(uri);
      const existingClients = this.__sessions.clientsOf(uri);
      this.__sessions.addOpen(uri, clientId);
      const record = this.trackingFor(uri);
      // Baseline the per-client staleness guard at the version id the client
      // declared for its own buffer (client-owned per LSP).
      record.clientVersions.set(clientId, td.version);
      if (clientId === LANGUAGE_CLIENT_ID) {
         // Remember the URI Monaco opened under (may differ from the canonical key)
         // so outbound applyEditToLanguageClient can address the URI it actually holds.
         // A fresh state, since a reopened buffer numbers its versions afresh.
         (record.languageClientDocuments ??= new Map()).set(this.toLanguageClientUri(td.uri), { declaredVersion: td.version });
      }
      if (!document) {
         // Use integrity-staged content if available, otherwise the client-provided (disk) text.
         const pendingText = this.consumePendingContent(uri);
         const text = pendingText ?? td.text;
         const source = pendingText ? ', source=pending' : '';
         // The SHARED version is server-assigned: continue the persisted
         // sequence — same version when the content is unchanged since the
         // last close (so watchers' base versions stay valid), one
         // step when it changed (so no stale pointer can coincidentally pass
         // the optimistic gate). An open with no sequence yet seeds it from the built root.
         const sequence = this.__versionSequences.get(uri);
         const version =
            sequence === undefined
               ? this.firstOpenVersion(uri, text, td.version)
               : sequence.contentHash === textHash(text)
                 ? sequence.version
                 : sequence.version + 1;
         this.log(uri, `Open document: Version ${version} by ${this.formatClientId(clientId)} [first client${source}]`);
         document = this.configuration.create(uri, td.languageId, version, text);
         this.__syncedDocuments.set(uri, document);
         this.setAuthor(uri, version, clientId);
         // The opener's text, not the staged content: a session's open read
         // it from the file, and an editor opened its buffer from there. An
         // editor that opens a buffer it never saved is taken as clean.
         record.diskBaseline = td.text;
         if (this.__releasedDirty.delete(uri)) {
            record.dirty = true;
         }
         this.refreshDirty(uri);
         if (clientId === LANGUAGE_CLIENT_ID) {
            // Baseline the shadow to what Monaco just opened so the next outbound
            // applyEditToLanguageClient diffs against the right starting point. Keyed by the
            // language-client URI (what Monaco holds), not the canonical document key.
            //
            // The CLIENT's declared text, never the synced document: staged content
            // consumed above leaves the two different, and a baseline asserting the
            // client already holds the staged text suppresses the one sync that would
            // deliver it. Skipped entirely when a push is already outstanding for this
            // URI — an `applyEdit` to a closed file has the client open from disk and
            // apply afterwards, so that shadow records what it is about to hold and
            // disk text would key the next diff to a buffer nobody has.
            const clientFacing = this.toLanguageClientUri(td.uri);
            if (!this.__shadow.isTracked(clientFacing)) {
               this.__shadow.set(clientFacing, td.text);
            }
         }
         const toFire = Object.freeze({ document, clientId });
         this.__onDidOpen.fire(toFire);
         this.__onDidChangeContent.fire(toFire);
      } else {
         // An additional client attaches to a document already open by another client.
         this.logClientJoined(uri, clientId, document.version, existingClients);
         if (clientId === LANGUAGE_CLIENT_ID) {
            // Monaco's own buffer, which on this path is NOT the synced text — another
            // client opened the document and may already have changed it. Recorded as
            // an equality-only baseline (never a diff one, see `setOpenedText`) so the
            // refresh below does not push a full replace of content Monaco already
            // holds, which would dirty the file on open.
            this.__shadow.setOpenedText(this.toLanguageClientUri(td.uri), td.text);
         }
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
    * The staleness guard baselines at the SYNCED version, not a declared buffer
    * version, because a client arriving this way holds no buffer of its own.
    * Unifying the two routes therefore rebaselines a textual client's guard to a
    * version it never declared.
    *
    * Returns whether a hold was added — `false` when `uri` is not open,
    * `clientId` already holds it, or the document was waiting out the revert
    * grace for other clients and was released instead (see
    * {@link resolvePendingRevert}); the caller then opens it anew.
    */
   attachClient(uri: DocumentUri, clientId: string): boolean {
      const key = this.documentKey(uri);
      if (!this.__syncedDocuments.has(key) || this.isOpenInClient(key, clientId)) {
         return false;
      }
      this.resolvePendingRevert(key, clientId);
      const document = this.__syncedDocuments.get(key);
      if (!document) {
         return false;
      }
      const existingClients = this.__sessions.clientsOf(key);
      this.__sessions.addOpen(key, clientId);
      const record = this.trackingFor(key);
      record.clientVersions.set(clientId, document.version);
      this.logClientJoined(key, clientId, document.version, existingClients);
      return true;
   }

   /**
    * The built root's recorded version, one on when `text` differs from the root's;
    * `declared` when the root records no store version. Seeded from `declared`, a write based
    * on the root passes the gate over other text, and the same text looks newer than its model.
    * A built root has no sequence only under a `LangiumDocuments` that does not reconcile at registration.
    */
   protected firstOpenVersion(uri: CanonicalUri, text: string, declared: number): number {
      const built = this.services.workspace.LangiumDocuments.getDocument(UriUtils.toUri(uri));
      if (built === undefined) {
         return declared;
      }
      const ledger = this.services.workspace.ModelLedger;
      const root = built.parseResult.value;
      const recorded = ledger.versionOf(root);
      if (recorded === UNRECORDED_VERSION || recorded === STALE_VERSION) {
         return declared;
      }
      return (ledger.textOf(root) ?? built.textDocument.getText()) === text ? recorded : recorded + 1;
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
    * for egress addressing (see {@link DocumentTrackingRecord.languageClientDocuments}). The
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

   /** Get-or-create the per-URI tracking record. `uri` must already be a {@link documentKey}. */
   protected trackingFor(uri: CanonicalUri): DocumentTrackingRecord {
      let record = this.__documents.get(uri);
      if (!record) {
         record = { versionAuthors: [], clientVersions: new Map() };
         this.__documents.set(uri, record);
      }
      return record;
   }

   setAuthor(uri: DocumentUri, version: number, author: string): void {
      this.trackingFor(this.documentKey(uri)).versionAuthors[version] = author;
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
      return this.get(uri)?.version ?? this.__versionSequences.get(this.documentKey(uri))?.version ?? 0;
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
         return { version: document.version, hash: this.heldTextHash(document), dirty: this.isDirty(uri) };
      }
      const sequence = this.__versionSequences.get(this.documentKey(uri));
      return sequence && { version: sequence.version, hash: sequence.contentHash, dirty: false };
   }

   /**
    * {@link textHash} of `document`'s text, taken once per version: the store
    * moves a document's version with every change of its text.
    */
   protected heldTextHash(document: T): string {
      const taken = this.__textHashes.get(document);
      if (taken?.version === document.version) {
         return taken.hash;
      }
      const hash = textHash(document.getText());
      this.__textHashes.set(document, { version: document.version, hash });
      return hash;
   }

   /**
    * Reconcile the persisted version sequence with content that reached the
    * build OUTSIDE the store's write paths — a closed document rebuilt from
    * disk (last-close revert) or replaced by a watched-file change. Steps the
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
      const hash = textHash(text);
      const sequence = this.__versionSequences.get(key);
      if (sequence === undefined) {
         this.__versionSequences.set(key, { version: 0, contentHash: hash });
         return 0;
      }
      if (hash === sequence.contentHash) {
         return sequence.version;
      }
      const stepped: VersionSequence = { version: sequence.version + 1, contentHash: hash };
      this.__versionSequences.set(key, stepped);
      this.logUri(key, `External content change while closed: sequence stepped to version ${stepped.version}`, 'debug');
      return stepped.version;
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
      const updated = this.configuration.update(document, [{ text: repaired }], document.version + 1);
      this.__syncedDocuments.set(key, updated);
      this.setAuthor(key, updated.version, INTEGRITY_CLIENT_ID);
      this.refreshDirty(key);
      this.log(updated.uri, `Update to version ${updated.version} by ${this.formatClientId(INTEGRITY_CLIENT_ID)} (repair)`);
      return { status: 'committed', document: updated };
   }

   getAuthor(uri: DocumentUri, version?: number): string | undefined {
      const history = this.__documents.get(this.documentKey(uri))?.versionAuthors;
      // Either the requested version, or the latest. `version !== undefined` so we treat 0 correctly.
      const clientId = version !== undefined ? history?.[version] : history?.at(-1);
      if (!clientId && history) {
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
    * subscriber that finds this `false` knows the last client just closed and a
    * disk re-read / rebuild can proceed.
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
    * or, for a lost client's last close, when its revert grace runs out,
    * another client opens it, or it is deleted. The document then reverts to
    * disk.
    */
   get onDidCloseLastOpen(): Event<LastOpenClosedEvent> {
      return this.lastOpenClosedEmitter.event;
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
    * Whether `uri` is waiting out the revert grace: its last open closed with a
    * lost connection, and it still holds its unsaved text. Such a document is
    * open for no client, yet not closed either, so a caller that would persist
    * a closed document's text to disk treats it as open.
    */
   isRevertPending(uri: DocumentUri): boolean {
      return this.__sessions.isRevertPending(this.documentKey(uri));
   }

   /**
    * Whether the store holds `uri` with text that differs from its disk
    * baseline: what the server last knew the file to hold. `false` for a URI
    * the store does not hold; a document waiting out the revert grace is still
    * held.
    *
    * The baseline is the text a first open brought, or what the server wrote,
    * or read back after an editor's save or a watched-file change, so it can
    * trail a change to the file that none of these has seen yet. A check that
    * must know the file reads it instead.
    */
   isDirty(uri: DocumentUri): boolean {
      return this.__documents.get(this.documentKey(uri))?.dirty ?? false;
   }

   /**
    * Fires each time the answer of {@link isDirty} changes. A dirty document's
    * release fires once a parse of the file reaches the store, at that text's
    * version, or without text once its revert removed the document or could
    * not rebuild it, though {@link isDirty} answers clean from the release on.
    */
   get onDidChangeDirty(): Event<DocumentDirtyChangedEvent> {
      return this.dirtyChangedEmitter.event;
   }

   /**
    * Record that the file behind `uri` holds `text`, or no file at all for
    * `undefined`. A no-op for a URI the store does not hold: the next first
    * open sets the baseline from its own text.
    */
   updateDiskBaseline(uri: DocumentUri, text: string | undefined): void {
      const key = this.documentKey(uri);
      const record = this.__documents.get(key);
      if (!record || !this.__syncedDocuments.has(key)) {
         return;
      }
      record.diskBaseline = text;
      this.refreshDirty(key);
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
      this.updateDiskBaseline(key, onDisk);
   }

   /** Compare the held text of `uri` with its baseline, and announce a changed answer. */
   protected refreshDirty(uri: CanonicalUri): void {
      const record = this.__documents.get(uri);
      const document = this.__syncedDocuments.get(uri);
      if (!record || !document) {
         return;
      }
      const dirty = document.getText() !== record.diskBaseline;
      if (dirty !== (record.dirty ?? false)) {
         record.dirty = dirty;
         this.dirtyChangedEmitter.fire(
            Object.freeze({ uri, text: { version: document.version, hash: this.heldTextHash(document), dirty } })
         );
      }
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
         this.__sessions.unregister(clientId);
         this.tracer.info(`Session closed: ${this.formatClientId(clientId)}`);
         this.tracer.trace(`Session closed: ${clientId}`);
      }
   }

   /**
    * Close every document the language client has open, as a `didClose` for
    * each would, so each last close reverts. For a host whose editor connection
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
         this.untrackLanguageClientDocuments(uri);
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
    * Stop tracking every URI the language client holds the document `key`
    * under, with its shadow and pending pushes. Call before a close by
    * canonical key that means all of them: a close for one URI while others
    * remain drops only that URI's and keeps the client's hold.
    */
   protected untrackLanguageClientDocuments(key: CanonicalUri): void {
      const languageClientDocuments = this.__documents.get(key)?.languageClientDocuments;
      for (const clientUri of languageClientDocuments?.keys() ?? []) {
         this.__shadow.invalidate(clientUri);
         this.__pendingPushes.delete(clientUri);
      }
      languageClientDocuments?.clear();
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
      this.untrackLanguageClientDocuments(key);
      for (const clientId of this.__sessions.clientsOf(key)) {
         this.notifyDidCloseTextDocument({ textDocument: { uri: key } }, clientId);
      }
      // A document waiting out the grace has no client left to close, and is
      // released now as its last close would have released it.
      if (this.__sessions.isRevertPending(key)) {
         this.__sessions.cancelRevert(key);
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
    * When `workspace/applyEdit` targets a closed file, the client opens it from
    * disk (stale) and sends `didOpen` before applying the edit. This staged
    * content is consumed by {@link notifyDidOpenTextDocument} to replace the
    * stale disk text, preventing a brief revert of the integrity update.
    *
    * Only a FIRST open consumes it, so stage only for a URI no client holds
    * ({@link isOpenInAnyClient} is `false`). A URI held only through another
    * head is not closed: an editor attaching to it joins the existing entry and
    * never reads the stage, and the last close discards the stage with the
    * tracking record. An entry lingers only if `workspace/applyEdit` fails and
    * the file is never opened — the memory cost is one serialised string per
    * URI.
    */
   stagePendingContent(uri: DocumentUri, text: string): void {
      this.trackingFor(this.documentKey(uri)).pendingContent = text;
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
    *
    * On `applyEdit` rejection (`result.applied === false`) or RPC failure the
    * shadow is invalidated so the next call sends a full-replace baseline.
    * Errors are re-thrown — callers wrap with their own retry / coalescing
    * policy as needed.
    *
    * The diff path is apply-verify-safe: the shadow internally checks that
    * `TextDocument.applyEdits(old, edits) === newText` and falls back to a
    * full replace on mismatch (logged via the warn-callback wired in the
    * constructor), so a diff regression becomes log noise, not data loss.
    *
    * That safety net verifies the diff against the SHADOW, which is what the
    * client is *believed* to hold — so it cannot see the client's buffer moving
    * underneath a push. A line-keyed edit is position-dependent: if a genuine
    * client keystroke lands between {@link LanguageClientTextShadow.computeEdits}
    * and the client applying, the ranges address the wrong lines and splice the
    * buffer (observed as a duplicated declaration, which the integrity tier then
    * "repairs" into a suffixed name and persists). The edit is therefore
    * addressed at the language client's last known version for that URI (see
    * {@link languageClientVersion}) rather than at `null` ("version
    * intentionally unknown"), which is what lets the client
    * reject a push its buffer has outrun. On rejection the shadow is invalidated,
    * so the caller's retry is a full-range replace — position-independent, and
    * safe to apply to whatever the client now holds.
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
      // The document is keyed by its canonical identity, but Monaco holds it under
      // the URI(s) it opened. Address each of those language-client URIs — the one
      // R→S translation, kept here at the egress. Usually one; more than one only
      // when the same file was opened under a symlink and its real path. Falls back
      // to the normalized URI when nothing is tracked. The shadow is keyed by each
      // URI, so every diff is against the right baseline.
      const recorded = this.__documents.get(this.documentKey(uri))?.languageClientDocuments;
      const targets: Iterable<LanguageClientUri> = recorded && recorded.size > 0 ? [...recorded.keys()] : [this.toLanguageClientUri(uri)];
      let lastResult: ApplyWorkspaceEditResult | undefined;
      for (const targetUri of targets) {
         // Read BEFORE computeEdits, which overwrites the baseline and drops
         // the opened snapshot. This is the text the client holds, and
         // therefore the only text its echo of this push can be reconstructed
         // against — whether or not the push below is keyed to it.
         const before = this.__shadow.clientText(targetUri);
         const edits = this.__shadow.computeEdits(targetUri, newText);
         if (edits.length === 0) {
            continue;
         }
         // Record the push for echo correlation BEFORE the RPC — the client's
         // echo can race the applyEdit response. See `__pendingPushes`.
         this.recordPendingPush(targetUri, before, newText);
         try {
            // Version the push only when it is position-DEPENDENT. A full-range
            // replace lands correctly on any buffer, so gating it would turn a
            // stale-by-one version into a refused update for no safety gain — and
            // it is exactly what the caller retries with after a rejection, so
            // gating it there would refuse the recovery too.
            const version = isFullReplace(edits) ? UNKNOWN_CLIENT_VERSION : this.languageClientVersion(uri, targetUri);
            // Captured before the await: a reopen replaces the state, so a late
            // reply then writes to the old one instead of the new buffer's.
            const languageClientDocument = recorded?.get(targetUri);
            // A full `ApplyWorkspaceEditParams`, `edit` and all — NOT a bare
            // `WorkspaceEdit` with a `label` beside it. `applyEdit` takes
            // `ApplyWorkspaceEditParams | WorkspaceEdit` and discriminates on
            // `!!value.edit`, so `{ label, documentChanges }` is wrapped as
            // `{ edit: { label, documentChanges } }` — putting the label inside
            // the edit, where LSP defines no such field and no client reads it.
            // The union is also what hides it at compile time: excess-property
            // checking admits a property present in EITHER member, so an object
            // matching neither type-checks against the union.
            const result = await connection.workspace.applyEdit({
               label: options?.label,
               edit: {
                  documentChanges: [TextDocumentEdit.create(OptionalVersionedTextDocumentIdentifier.create(targetUri, version), edits)]
               }
            });
            if (result && result.applied === false) {
               this.__shadow.invalidate(targetUri);
               this.__pendingPushes.delete(targetUri);
               if (version !== UNKNOWN_CLIENT_VERSION) {
                  this.tracer
                     .with(uri)
                     .warn(
                        `Language client refused applyEdit addressed at version ${version} (it last declared version ${languageClientDocument?.declaredVersion})`
                     );
               }
            } else if (result?.applied && version !== UNKNOWN_CLIENT_VERSION && languageClientDocument) {
               // A client steps once per applied edit that changes its buffer. A
               // line edit does while the shadow is right; a full replace may be a
               // no-op the client drops. Left to the echo, a push sent first is
               // refused; advanced after a no-op, one could pass at a version a
               // keystroke reached.
               languageClientDocument.pushedVersion = version + 1;
            }
            lastResult = result;
         } catch (err) {
            this.__shadow.invalidate(targetUri);
            this.__pendingPushes.delete(targetUri);
            throw err;
         }
      }
      return lastResult;
   }

   /**
    * The version the LSP textual language client holds `uri` at under
    * `targetUri`, for addressing an outgoing `workspace/applyEdit`.
    *
    * Client version ids are CLIENT-owned per LSP, so this is the id the client
    * itself stamped on its last `didOpen` / `didChange` for `targetUri`, or the
    * one an applied push moved it to ahead of the push's echo
    * ({@link LanguageClientDocumentState}) — never the shared server version,
    * which advances on authored writes the client knows nothing about and would
    * therefore reject every push.
    *
    * Falls back to {@link UNKNOWN_CLIENT_VERSION} when the client has not opened
    * the document under `targetUri`, which is the honest answer. That is also
    * the case in which there is no shadow, so the push is already a
    * position-independent full replace and has nothing to gain from a gate.
    */
   protected languageClientVersion(uri: DocumentUri, targetUri: LanguageClientUri = this.toLanguageClientUri(uri)): number {
      const state = this.__documents.get(this.documentKey(uri))?.languageClientDocuments?.get(targetUri);
      if (state === undefined) {
         return UNKNOWN_CLIENT_VERSION;
      }
      return Math.max(state.declaredVersion, state.pushedVersion ?? state.declaredVersion);
   }

   /**
    * Append a push to the in-flight queue for `targetUri`
    * (see {@link __pendingPushes}). Bounded: beyond
    * {@link PENDING_ECHO_CAP} the oldest entry drops with a debug log — an
    * echo that far outstanding means the client is not echoing at all, and
    * an unbounded queue must not become the leak.
    */
   protected recordPendingPush(targetUri: LanguageClientUri, before: string | undefined, newText: string): void {
      let pending = this.__pendingPushes.get(targetUri);
      if (!pending) {
         pending = [];
         this.__pendingPushes.set(targetUri, pending);
      }
      pending.push({ before, afterHash: textHash(newText) });
      if (pending.length > PENDING_ECHO_CAP) {
         pending.shift();
         this.logUri(targetUri, `Pending-echo queue exceeded ${PENDING_ECHO_CAP} entries; dropped the oldest`, 'debug');
      }
   }

   /**
    * Decide what an incoming language-client change actually is, by
    * reconstructing the client's resulting buffer against the text its ranges
    * address — the pre-push buffer of the OLDEST push still in flight for
    * `clientFacing`, else whatever that client is believed to hold.
    *
    * `undefined` when the client's ranges address the synced text itself —
    * nothing in flight, and no evidence the client holds anything else. That
    * is the ordinary path, and the caller then applies the ranges directly.
    * The two texts part company without a push in flight whenever a client
    * attaches to a document another client has already written: it opened
    * from disk, so applying its ranges to the synced text splices lines they
    * never addressed.
    *
    * **Why the oldest, and why reconstruct at all.** The client applies our
    * pushes in order and echoes each against the buffer it held before that
    * push, so the first echo to arrive belongs to the oldest entry — a FIFO
    * correspondence the queue preserves by consuming from the front. Comparing
    * the reconstruction against every pending hash, not only the oldest, is
    * what recognises an echo that a newer write already superseded: a rapid
    * write sequence can deliver the echo of push N after the store applied
    * push N+1, and everything older is then accounted for too.
    *
    * A reconstruction matching NO pending push means the client's buffer went
    * somewhere we did not send it — it coalesced a keystroke into the echo, or
    * typed before the push landed. That text is authoritative, and the queue
    * drops: the client has stopped being a pure mirror, so no outstanding echo
    * can match again. (A push still in flight at that point will be refused by
    * the client's own version gate, which invalidates the shadow and makes the
    * next sync a position-independent full replace.)
    *
    * Content equality is a sound echo proof because entries live only between a
    * push and its echo — a milliseconds window, never history — and the
    * client's `didChange` stream is ordered, so every buffer state arrives in
    * mutation order. An UNDO returning the buffer to previously-pushed text is
    * therefore never swallowed: the edit that preceded it already emptied the
    * queue, so undo revisits PAST states while the queue holds IN-FLIGHT ones.
    */
   protected classifyLanguageClientChange(
      clientFacing: LanguageClientUri,
      document: T,
      changes: TextDocumentContentChangeEvent[]
   ): LanguageClientChangeOrigin | undefined {
      const queued = this.__pendingPushes.get(clientFacing);
      const pending = queued?.length ? queued : undefined;
      // The text the client's ranges address: the buffer it held before the
      // oldest push still in flight, else the buffer it is believed to hold.
      const clientText = pending?.[0].before ?? this.__shadow.clientText(clientFacing);
      if (pending === undefined && (clientText === undefined || clientText === document.getText())) {
         return undefined;
      }
      if (pending !== undefined && pending[0].before === undefined && changes.some(change => ContentChange.isIncremental(change))) {
         // A push sent to a client whose buffer was unknown — a first sync, or
         // the recovery push after a rejection. The shadow now holds the text
         // that push MOVES the client to, which is the one text the echo's
         // ranges provably do not address, so the fallback above is a baseline
         // known to be wrong rather than merely unverified. Drop the queue and
         // the shadow: the next sync is then a full replace, which lands on
         // whatever the client holds. A full-text change is exempt because it
         // reconstructs identically against any baseline.
         pending.length = 0;
         this.__shadow.invalidate(clientFacing);
         return { kind: 'unreconstructable' };
      }
      // Through the configured factories, not `TextDocument` directly, so an
      // adopter's custom text-document type governs how the ranges are applied
      // here exactly as it does on the synced document.
      const probe = this.create(clientFacing, document.languageId, 0, clientText ?? document.getText());
      const reconstructed = this.update(probe, changes, 0).getText();
      if (pending !== undefined) {
         const matchIndex = pending.findIndex(push => push.afterHash === textHash(reconstructed));
         if (matchIndex >= 0) {
            pending.splice(0, matchIndex + 1);
            return { kind: 'echo' };
         }
         pending.length = 0;
      }
      return { kind: 'divergent', text: reconstructed };
   }

   /**
    * Explicitly baseline the language-client text shadow for a URI. Useful in
    * tests and for adopters that need to seed the shadow without going through
    * a `didOpen` event (e.g. after a sideband save). Normal didOpen / didChange
    * paths from the LSP language client already auto-track the shadow.
    */
   setLanguageClientText(uri: DocumentUri, text: string): void {
      const clientFacing = this.toLanguageClientUri(uri);
      this.__shadow.set(clientFacing, text);
      // An explicit rebaseline supersedes whatever was in flight.
      this.__pendingPushes.delete(clientFacing);
   }

   /** Drop the shadow baseline for a URI; the next applyEditToLanguageClient sends a full replace. */
   invalidateLanguageClientText(uri: DocumentUri): void {
      const clientFacing = this.toLanguageClientUri(uri);
      this.__shadow.invalidate(clientFacing);
      this.__pendingPushes.delete(clientFacing);
   }

   protected consumePendingContent(uri: DocumentUri): string | undefined {
      const record = this.__documents.get(this.documentKey(uri));
      const content = record?.pendingContent;
      if (record) {
         record.pendingContent = undefined;
      }
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
