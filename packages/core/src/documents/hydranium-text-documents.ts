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
import { UriUtils } from '@hydranium/langium';
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
   type Emitter,
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
import { type CanonicalUri, type LanguageClientUri, asLanguageClientUri, DisposableCollection, type Tracer } from '@hydranium/protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { LANGUAGE_CLIENT_ID } from './client-ids.js';
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
 */
interface DocumentTracking {
   /** Client ids currently holding this document open (multi-client membership). */
   readonly clients: Set<string>;
   /** Author of each version, sparse-indexed by the SHARED (server-assigned) version number. */
   readonly versionAuthors: string[];
   /**
    * Last version id each client declared for this document (didOpen baseline,
    * advanced by every accepted didChange). Client version ids are CLIENT-owned
    * per LSP (Monaco numbers its own buffer) and are used ONLY for this
    * per-client staleness guard — they never leak into the shared version
    * sequence, which the server assigns (see {@link HydraniumTextDocuments.__versionSequences}).
    */
   readonly clientVersions: Map<string, number>;
   /** Content staged by integrity rules for a closed document. Consumed on next open. */
   pendingContent?: string;
   /**
    * The URI(s) the LSP textual language client opened this (canonically-keyed)
    * document under. Usually one; a set because the same physical file can be
    * opened under more than one URI (a symlink path and its real path). This is
    * the egress address: `applyEditToLanguageClient`
    * targets these, since the document is *keyed* by its canonical identity but
    * Monaco holds it under the URI it opened. Lifecycle-bound — cleared with the
    * record on last close.
    */
   languageClientUris?: Set<LanguageClientUri>;
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
 * Where a URI's shared version sequence left off — written once at last-client
 * close, consulted at the next open so the sequence CONTINUES instead of
 * restarting at whatever version id the reopening client declares. One entry
 * of {@link HydraniumTextDocuments.__versionSequences}.
 */
interface VersionSequence {
   /** The shared version at last-client close. */
   readonly version: number;
   /** {@link contentHash} of the synced text at last-client close. */
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
 * come back yet. One entry of {@link HydraniumTextDocuments.__pendingPushes}.
 */
interface PendingPush {
   /**
    * The text the client held BEFORE this push — the shadow baseline the
    * push's edits were diffed against, and therefore the text the client's
    * echo addresses with its ranges.
    *
    * `undefined` when the push was a full replace sent with no baseline (a
    * first sync, or the recovery push after a rejection). There is then no
    * knowing what the client held, so the echo is reconstructed against the
    * synced text instead — which is sound for a full replace, whose
    * application is position-independent.
    */
   readonly before: string | undefined;
   /** {@link contentHash} of the text this push moves the client to. */
   readonly afterHash: string;
}

/**
 * What an incoming language-client change turns out to be once reconstructed
 * against the pushes still in flight — the return of
 * {@link HydraniumTextDocuments.classifyLanguageClientChange}.
 */
type LanguageClientChangeOrigin =
   /** The client is reporting a text we pushed it. The synced document is already there. */
   | { readonly kind: 'echo' }
   /**
    * The client's buffer has moved somewhere we did not push it — it coalesced
    * a genuine keystroke into the echo, or typed before the push arrived. The
    * reconstructed text is what it now holds, and is authoritative.
    */
   | { readonly kind: 'divergent'; readonly text: string };

/**
 * Cheap, stable, non-cryptographic content hash (cyrb53) for the version
 * sequence's "did the content change across close/reopen?" question. Only
 * needs to be collision-resistant enough that an accidental match across two
 * DIFFERENT revisions of the same file is practically impossible; 53 bits of
 * a well-mixed hash over full text + length gives that without pulling in
 * `node:crypto` (this module must stay runnable in browser hosts).
 */
function contentHash(text: string): string {
   let h1 = 0xdeadbeef;
   let h2 = 0x41c6ce57;
   for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
   }
   h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
   h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
   h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
   h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
   return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}:${text.length}`;
}

/**
 * Multi-client text-document tracking on top of Langium's `NormalizedTextDocuments`.
 *
 * Adds the framework features used by the integrity, model-server, and GLSP layers:
 *   - Per-document client membership (multiple clients can attach to the same URI).
 *   - A SERVER-OWNED shared version sequence: per-URI, monotonic across
 *     close/reopen cycles, advancing exactly when the synced content changes.
 *     Client-declared version ids (Monaco's buffer numbering) feed only a
 *     per-client staleness guard and never leak into the shared sequence —
 *     the two are different things (an editor's edit-operation counter vs the
 *     document's content-revision number), and splicing them lets versions drift
 *     silently past `baseVersion` gate holders.
 *   - Version-author history so each edit is attributable to its originating client.
 *   - Pending-content staging used by the integrity service to thread corrections
 *     through `workspace/applyEdit` cycles for currently-closed documents.
 *   - `didOpen` notifications arriving over the LSP connection wait on the
 *     workspace-ready promise, so a client's first open cannot race workspace
 *     discovery. Direct {@link notifyDidOpenTextDocument} calls (the non-LSP
 *     heads) do not pass that gate — their caller owns the ordering.
 */
export class HydraniumTextDocuments<T extends TextDocument = TextDocument> extends NormalizedTextDocuments<T> {
   /**
    * Per-URI client-facing tracking ({@link DocumentTracking}): client
    * membership, version-author history, and integrity-staged pending content,
    * keyed by normalized URI. One record per URI so the last-client close clears
    * every axis atomically. The language-client diff baseline stays in
    * {@link __shadow} (its own abstraction); the parsed-document store stays in
    * the inherited `__syncedDocuments`.
    */
   protected __documents = new Map<CanonicalUri, DocumentTracking>();

   /**
    * Per-URI shared-version continuity across close/reopen cycles
    * ({@link VersionSequence}), written at last-client close and consulted by
    * the next first-client open. DELIBERATELY outside {@link DocumentTracking}:
    * that record is deleted on last close, while the version sequence must
    * survive it — the shared version is a server-owned, monotonic,
    * advances-iff-content-changes counter that never resets while the server
    * lives. That invariant is what makes an optimistic `baseVersion` gate
    * sound: "version unchanged ⇔ content unchanged", with no false conflicts
    * from close/reopen version resets and no false passes from a reopened
    * sequence coincidentally landing on a stale writer's number.
    *
    * Never pruned: two small values per URI ever touched — bounded by
    * workspace size, not by activity.
    */
   protected readonly __versionSequences = new Map<CanonicalUri, VersionSequence>();

   /**
    * Texts pushed to the LSP textual language client via
    * {@link applyEditToLanguageClient} whose echoes have not come back yet
    * ({@link PendingPush}), keyed like the shadow by language-client URI.
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
   protected readonly __pendingPushes = new Map<LanguageClientUri, PendingPush[]>();

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
            await this.services.workspace.WorkspaceManager.workspaceInitialized;
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
            this.notifyDidSaveTextDocument(event);
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
         // conservative answer.
         const record = this.trackingFor(uri);
         const lastSeen = record.clientVersions.get(clientId) ?? document.version;
         if (lastSeen >= td.version) {
            // Distinguish "already at this version" (common: an echo from the client that triggered
            // the update) from "incoming version older than ours" (stale race).
            const reason =
               lastSeen === td.version ? `already at version ${lastSeen}` : `incoming version ${td.version} older than current ${lastSeen}`;
            this.logUri(uri, `Ignore update by ${clientId}: ${reason}`, 'debug');
            return;
         }
         record.clientVersions.set(clientId, td.version);

         // A language-client change arriving while one of our own pushes is in
         // flight is keyed to the buffer the client held BEFORE that push, NOT
         // to the synced text — the authored write already advanced the latter.
         // Resolve which it is, and against what, before touching anything.
         const inFlight =
            clientId === LANGUAGE_CLIENT_ID
               ? this.classifyLanguageClientChange(this.toLanguageClientUri(td.uri), document, changes)
               : undefined;
         if (inFlight?.kind === 'echo') {
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

         // The SHARED version advances iff the content actually changes — the
         // invariant optimistic `baseVersion` gates rely on. The new text is
         // only known after applying the (possibly incremental) changes, so
         // apply at a tentative +1 and roll the version back on an identical
         // result (an empty-changes update only re-stamps the version).
         //
         // A divergent in-flight change is applied as its RECONSTRUCTED text
         // rather than as its own ranges: the ranges address the pre-push
         // baseline, so applying them here would splice the wrong lines.
         const previousText = document.getText();
         const sharedVersion = document.version;
         document = this.configuration.update(document, inFlight === undefined ? changes : [{ text: inFlight.text }], sharedVersion + 1);
         const changed = document.getText() !== previousText;
         if (!changed) {
            document = this.configuration.update(document, [], sharedVersion);
         }
         this.__syncedDocuments.set(uri, document);
         if (changed) {
            this.setAuthor(uri, document.version, clientId);
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
         this.log(document.uri, `Update to version ${document.version} by ${clientId}${changed ? '' : ' (content unchanged)'}`);
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
    * `baseVersion` pointers stay valid.
    *
    * Returns the resulting shared version. Throws when the document is not
    * open — callers (`AstDocumentManager.update`) open first.
    */
   applyContentChange(uri: DocumentUri, text: string, clientId: string): number {
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
      }
      this.log(document.uri, `Update to version ${document.version} by ${clientId}${changed ? '' : ' (content unchanged)'}`);
      this.__onDidChangeContent.fire(Object.freeze({ document, clientId }));
      return document.version;
   }

   public notifyDidCloseTextDocument(event: DidCloseTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const uri = this.documentKey(event.textDocument.uri);
      if (!this.isOpenInClient(uri, clientId)) {
         return;
      }
      const closingRecord = this.__documents.get(uri);
      closingRecord?.clients.delete(clientId);
      closingRecord?.clientVersions.delete(clientId);
      const syncedDocument = this.__syncedDocuments.get(uri);
      if (syncedDocument !== undefined) {
         this.log(syncedDocument.uri, `Closed synced document: ${syncedDocument.version} by ${clientId}`);
         this.__onDidClose.fire(Object.freeze({ document: syncedDocument, clientId }));

         if (clientId === LANGUAGE_CLIENT_ID) {
            // Monaco closed the document; drop the URI it held and the shadow
            // baselined under it. (If this was the last URI/client the whole record
            // is deleted below, clearing the set anyway.)
            const droppedUri = this.toLanguageClientUri(event.textDocument.uri);
            this.__documents.get(uri)?.languageClientUris?.delete(droppedUri);
            this.__shadow.invalidate(droppedUri);
            this.__pendingPushes.delete(droppedUri);
         }
         if (!this.__documents.get(uri)?.clients.size) {
            // Last client closed the document; delete sync state. The downstream
            // "rebuild from disk for file URIs / drop from index for ephemeral
            // URIs" decision lives in `HydraniumDocumentUpdateHandler.didCloseDocument`,
            // which subscribes to `onDidClose` and consults `isOpenInAnyClient`
            // to detect the last-close transition.
            this.log(syncedDocument.uri, `Remove synced document: ${syncedDocument.version} (no client left)`);
            // Persist where the shared version sequence left off (version +
            // content hash) so the next open CONTINUES the sequence instead of
            // restarting at the reopening client's declared id. Hashed once
            // here at close, not on every change.
            this.__versionSequences.set(uri, {
               version: syncedDocument.version,
               contentHash: contentHash(syncedDocument.getText())
            });
            this.__syncedDocuments.delete(uri);
            // One delete clears every per-URI axis (version history + any staged
            // pending content) so a future open with the same URI starts fresh.
            this.__documents.delete(uri);
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

   public notifyDidSaveTextDocument(event: DidSaveTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(event.textDocument.uri));
      if (syncedDocument !== undefined) {
         this.log(syncedDocument.uri, `Saved synced document: ${syncedDocument.version} by ${clientId}`);
         this.__onDidSave.fire(Object.freeze({ document: syncedDocument, clientId }));
      }
   }

   public notifyDidOpenTextDocument(event: DidOpenTextDocumentParams, clientId = LANGUAGE_CLIENT_ID): void {
      const td = event.textDocument;
      const uri = this.documentKey(td.uri);
      if (this.isOpenInClient(uri, clientId)) {
         // Already open for this client under this canonical identity. If this is a
         // NEW client-facing URI for the same file (a second tab reached via a
         // divergent path, e.g. a symlink and its real path), record it and baseline
         // its shadow so outbound edits reach this tab too — but do NOT re-fire
         // open/rebuild; the document is already live.
         if (clientId === LANGUAGE_CLIENT_ID) {
            const clientFacing = this.toLanguageClientUri(td.uri);
            const record = this.__documents.get(uri);
            if (record && !record.languageClientUris?.has(clientFacing)) {
               (record.languageClientUris ??= new Set<LanguageClientUri>()).add(clientFacing);
               const open = this.__syncedDocuments.get(uri);
               if (open) {
                  this.__shadow.set(clientFacing, open.getText());
               }
            }
         }
         return;
      }
      let document = this.__syncedDocuments.get(uri);
      const record = this.trackingFor(uri);
      const existingClients = [...record.clients];
      record.clients.add(clientId);
      // Baseline the per-client staleness guard at the version id the client
      // declared for its own buffer (client-owned per LSP).
      record.clientVersions.set(clientId, td.version);
      if (clientId === LANGUAGE_CLIENT_ID) {
         // Remember the URI Monaco opened under (may differ from the canonical key)
         // so outbound applyEditToLanguageClient can address the URI it actually holds.
         (record.languageClientUris ??= new Set<LanguageClientUri>()).add(this.toLanguageClientUri(td.uri));
      }
      if (!document) {
         // Use integrity-staged content if available, otherwise the client-provided (disk) text.
         const pendingText = this.consumePendingContent(uri);
         const text = pendingText ?? td.text;
         const source = pendingText ? ', source=pending' : '';
         // The SHARED version is server-assigned: continue the persisted
         // sequence — same version when the content is unchanged since the
         // last close (so watchers' `baseVersion` pointers stay valid), one
         // step when it changed (so no stale pointer can coincidentally pass
         // the optimistic gate). Only a first-ever open adopts the client's
         // declared id as the sequence seed.
         const sequence = this.__versionSequences.get(uri);
         const version =
            sequence === undefined ? td.version : sequence.contentHash === contentHash(text) ? sequence.version : sequence.version + 1;
         this.log(uri, `Open document: Version ${version} by ${clientId} [first client${source}]`);
         document = this.configuration.create(uri, td.languageId, version, text);
         this.__syncedDocuments.set(uri, document);
         this.setAuthor(uri, version, clientId);
         if (clientId === LANGUAGE_CLIENT_ID) {
            // Baseline the shadow to what Monaco just opened so the next outbound
            // applyEditToLanguageClient diffs against the right starting point. Keyed by the
            // language-client URI (what Monaco holds), not the canonical document key.
            this.__shadow.set(this.toLanguageClientUri(td.uri), document.getText());
         }
         const toFire = Object.freeze({ document, clientId });
         this.__onDidOpen.fire(toFire);
         this.__onDidChangeContent.fire(toFire);
      } else {
         // An additional client attaches to a document already open by another client.
         this.log(
            uri,
            `Attach client: ${clientId} joined existing document (version ${document.version}, ` +
               `now open in: ${[...existingClients, clientId].join(', ')})`
         );
         this.refreshContent(uri, clientId);
      }
   }

   refreshContent(uri: DocumentUri, clientId: string): void {
      const syncedDocument = this.__syncedDocuments.get(this.documentKey(uri));
      if (syncedDocument) {
         // Trigger a (re-)build by firing a change event.
         const timer = this.startTimerForUri(
            syncedDocument.uri,
            `Refresh synced document: Version ${syncedDocument.version} by ${clientId}`
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
    * for egress addressing (see {@link DocumentTracking.languageClientUris}). The
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
   protected trackingFor(uri: CanonicalUri): DocumentTracking {
      let record = this.__documents.get(uri);
      if (!record) {
         record = { clients: new Set(), versionAuthors: [], clientVersions: new Map() };
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
    * version, else where the persisted sequence left off at last close, else
    * `0` for a URI this store has never seen. The shared sequence is
    * server-owned and monotonic across close/reopen cycles, and advances
    * exactly when the synced content changes — which is what makes it a sound
    * optimistic-concurrency token (`baseVersion` gates): version unchanged ⇔
    * content unchanged.
    */
   version(uri: DocumentUri): number {
      return this.get(uri)?.version ?? this.__versionSequences.get(this.documentKey(uri))?.version ?? 0;
   }

   /**
    * Reconcile the persisted version sequence with content that reached the
    * build OUTSIDE the store's write paths — a closed document rebuilt from
    * disk (last-close revert) or replaced by a watched-file change. Steps the
    * sequence iff `text` differs from the sequence's last-known content and
    * returns the resulting sequence version so the caller can re-stamp the
    * rebuilt document (see the `AstDocumentManager` Parsed-phase listener) —
    * keeping the "version advances iff content changes" invariant for
    * documents no client currently holds.
    *
    * Returns `undefined` — and does nothing — when the document is open (the
    * store's own content is authoritative; external transitions never reach
    * the Langium factory for open documents) or was never tracked (no gate
    * holder can hold a version pointer for it, and the early exit keeps
    * workspace-wide builds from hashing every untouched document).
    */
   reconcileExternalContent(uri: DocumentUri, text: string): number | undefined {
      const key = this.documentKey(uri);
      if (this.__syncedDocuments.has(key)) {
         return undefined;
      }
      const sequence = this.__versionSequences.get(key);
      if (sequence === undefined) {
         return undefined;
      }
      const hash = contentHash(text);
      if (hash === sequence.contentHash) {
         return sequence.version;
      }
      const stepped: VersionSequence = { version: sequence.version + 1, contentHash: hash };
      this.__versionSequences.set(key, stepped);
      this.logUri(key, `External content change while closed: sequence stepped to version ${stepped.version}`, 'debug');
      return stepped.version;
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
    * during the close event itself. `isOpenInAnyClient` reads the tracking
    * record's `clients` set, which is updated BEFORE the fire, so an `onDidClose`
    * subscriber that finds this `false` knows the last client just closed and a
    * disk re-read / rebuild can proceed.
    */
   isOpenInAnyClient(uri: DocumentUri): boolean {
      return (this.__documents.get(this.documentKey(uri))?.clients.size ?? 0) > 0;
   }

   isOpenInClient(uri: DocumentUri, client: string): boolean {
      return !!this.__documents.get(this.documentKey(uri))?.clients.has(client);
   }

   isOpenInLanguageClient(uri: DocumentUri): boolean {
      // Takes any URI form (canonicalizes internally via `documentKey`, like
      // `isOpen`); the document is keyed canonically, so a canonical or a
      // client-facing URI both resolve to the same registration.
      return this.isOpenInClient(uri, LANGUAGE_CLIENT_ID);
   }

   isOnlyOpenInClient(uri: DocumentUri, client: string): boolean {
      const key = this.documentKey(uri);
      return this.__documents.get(key)?.clients.size === 1 && this.isOpenInClient(key, client);
   }

   /**
    * Every document currently held open by at least one client, with the client
    * ids holding it. Reads the same per-URI tracking records as
    * {@link isOpenInAnyClient}, so it reflects a last-client close immediately.
    *
    * Diagnostics-oriented — the server-state snapshot lists these so an operator
    * can see WHY a document is pinned: a document that lingers here after its
    * editor closed points directly at the client that failed to close it (and,
    * under a shedding policy, explains why its CST is never shed).
    */
   openDocuments(): OpenDocument[] {
      const result: OpenDocument[] = [];
      for (const [uri, tracking] of this.__documents) {
         if (tracking.clients.size > 0) {
            result.push({ uri, clients: [...tracking.clients] });
         }
      }
      return result;
   }

   /**
    * Stages integrity-updated content for a closed document.
    *
    * When `workspace/applyEdit` targets a closed file, the client opens it from
    * disk (stale) and sends `didOpen` before applying the edit. This staged
    * content is consumed by {@link notifyDidOpenTextDocument} to replace the
    * stale disk text, preventing a brief revert of the integrity update.
    *
    * Not cleared on close: pending content is only staged for already-closed
    * documents (the integrity service checks `isOpenInLanguageClient` first), so
    * a close → stage → open cycle cannot occur. The only scenario where an
    * entry lingers is if `workspace/applyEdit` fails and the file is never
    * opened — the memory cost is one serialised string per URI.
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
    * addressed at the language client's LAST DECLARED VERSION rather than at
    * `null` ("version intentionally unknown"), which is what lets the client
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
      const recorded = this.__documents.get(this.documentKey(uri))?.languageClientUris;
      const targets: Iterable<LanguageClientUri> = recorded && recorded.size > 0 ? recorded : [this.toLanguageClientUri(uri)];
      let lastResult: ApplyWorkspaceEditResult | undefined;
      for (const targetUri of targets) {
         // Read BEFORE computeEdits, which overwrites it. This is the text the
         // edits below are keyed to, and therefore the only text the client's
         // echo of them can be reconstructed against.
         const before = this.__shadow.get(targetUri);
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
            const version = isFullReplace(edits) ? UNKNOWN_CLIENT_VERSION : this.languageClientVersion(uri);
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
    * The version the LSP textual language client last declared for `uri`, for
    * addressing an outgoing `workspace/applyEdit`.
    *
    * Client version ids are CLIENT-owned per LSP, so this is the id the client
    * itself stamped on its last `didOpen` / `didChange` — never the shared
    * server version, which advances on authored writes the client knows nothing
    * about and would therefore reject every push.
    *
    * Falls back to {@link UNKNOWN_CLIENT_VERSION} when the client has never
    * declared one, which is the honest answer for a document it has not opened.
    * That is also the case in which there is no shadow, so the push is already a
    * position-independent full replace and has nothing to gain from a gate.
    */
   protected languageClientVersion(uri: DocumentUri): number {
      return this.__documents.get(this.documentKey(uri))?.clientVersions.get(LANGUAGE_CLIENT_ID) ?? UNKNOWN_CLIENT_VERSION;
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
      pending.push({ before, afterHash: contentHash(newText) });
      if (pending.length > PENDING_ECHO_CAP) {
         pending.shift();
         this.logUri(targetUri, `Pending-echo queue exceeded ${PENDING_ECHO_CAP} entries; dropped the oldest`, 'debug');
      }
   }

   /**
    * Decide what an incoming language-client change actually is, by
    * reconstructing the client's resulting buffer against the OLDEST push still
    * in flight for `clientFacing`.
    *
    * `undefined` when nothing of ours is in flight, which is the ordinary path:
    * the client's ranges then address the synced text and the caller applies
    * them to it directly.
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
      const pending = this.__pendingPushes.get(clientFacing);
      if (pending === undefined || pending.length === 0) {
         return undefined;
      }
      // Through the configured factories, not `TextDocument` directly, so an
      // adopter's custom text-document type governs how the ranges are applied
      // here exactly as it does on the synced document.
      const probe = this.create(clientFacing, document.languageId, 0, pending[0].before ?? document.getText());
      const clientText = this.update(probe, changes, 0).getText();
      const matchIndex = pending.findIndex(push => push.afterHash === contentHash(clientText));
      if (matchIndex >= 0) {
         pending.splice(0, matchIndex + 1);
         return { kind: 'echo' };
      }
      pending.length = 0;
      return { kind: 'divergent', text: clientText };
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
