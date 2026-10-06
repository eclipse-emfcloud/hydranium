/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Debouncer, Deferred, type Logger, ObservableValue, type MaybeObservableValue, TIMED_OUT } from '@hydranium/protocol';
import { URI, UriUtils } from '@hydranium/langium';
import { DefaultDocumentUpdateHandler } from '@hydranium/langium/lsp';
import { HYDRANIUM_BUILD_REASONS, type HydraniumDocumentBuilder } from '../langium/document-builder/document-builder.js';
import { type ServerSharedServices } from '../langium/module.js';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import { type SelfSaveRegistry } from '../langium/workspace/self-save-registry.js';
import { type WritableFileSystemProvider } from '../langium/workspace/file-system-provider.js';
import { type HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';
import { isConnectionGoneError } from '../util/connection-liveness.js';
import {
   type DidChangeWatchedFilesParams,
   type FileEvent,
   FileChangeType,
   type TextDocumentChangeEvent,
   type TextDocumentWillSaveEvent,
   type TextEdit
} from 'vscode-languageserver';
import { type TextDocument } from 'vscode-languageserver-textdocument';

export { HYDRANIUM_BUILD_REASONS };

/**
 * Construction options for {@link HydraniumDocumentUpdateHandler}.
 */
export interface HydraniumDocumentUpdateHandlerOptions {
   /**
    * Trailing-edge debounce window. `0` (the default) disables
    * debouncing — `didChangeContent` flows synchronously into
    * `fireDocumentUpdate` as in Langium's default. Accepts an
    * {@link MaybeObservableValue} so adopters can bind to a user setting via
    * `Settings.number`; updates to the underlying snapshot reshape
    * the live debounce window without rebuilding the handler.
    */
   readonly debounceMs?: MaybeObservableValue<number>;
   /**
    * Bypass debouncing for changes whose author is anything other
    * than the language client (Monaco). GLSP / form-editor /
    * integrity-rule author changes are already coalesced upstream —
    * debouncing them adds latency for no benefit. Default `true`.
    *
    * Adopters disable this when they want uniform debouncing
    * regardless of source (rare — typically only for synthetic
    * load tests).
    */
   readonly bypassNonLanguageClientChanges?: boolean;
   /**
    * Longest an editor's save waits on the server, in milliseconds, at each of
    * its two steps: the `willSaveWaitUntil` answer waits for the server's disk
    * writes of the document already queued, and server writes queued after the
    * answer wait for the editor's `didSave`. Either wait that runs out is
    * logged, and the editor's write and the server's can then land in either
    * order. Default `1000`: VS Code gives up on an answer after about 1.5 s,
    * and switches the listener off for the session once four answers, over
    * all documents, timed out or failed.
    */
   readonly willSaveGateMs?: number;
}

/**
 * Framework `DocumentUpdateHandler` adding these behaviours over Langium's
 * default:
 *
 *  1. **Self-save filter** ({@link filterSelfSaves}) — drops
 *     watched-file-change echoes for the server's own writes via
 *     {@link SelfSaveRegistry}, keyed by `fsPath` + mtime.
 *  2. **Trailing-edge debouncing** — collapses rapid
 *     `didChangeContent` calls into one rebuild on the trailing
 *     edge of the configured window. Non-language-client author
 *     changes and watched-file changes bypass the debounce (their
 *     producers are already coalesced).
 *  3. **Build-reason stamping** — the LSP event overrides
 *     (`didOpenDocument`, `didChangeContent`, `didChangeWatchedFiles`)
 *     populate {@link nextReason} with a canonical reason string.
 *     {@link fireDocumentUpdate} captures the reason; {@link dispatch} hands
 *     it to {@link HydraniumDocumentBuilder.scheduleUpdate}, which stages it
 *     through {@link HydraniumDocumentBuilder.markNextReason} when the build
 *     runs, so a subclass that formats build logs can tag its line with the
 *     event that caused the build without per-adopter wiring to capture it.
 *  4. **Editor save gate** ({@link willSaveDocumentWaitUntil}) — the editor
 *     writes the file itself, so the server's disk writes of that document
 *     are ordered around it: the editor's save waits for the ones already
 *     queued, and the ones queued during its save wait for its `didSave`.
 *     Both waits are capped by
 *     {@link HydraniumDocumentUpdateHandlerOptions.willSaveGateMs}.
 *
 * What the build keeps after a document's last close is not dispatched here:
 * the store hands the released document to the `DocumentReleaseHandler` for
 * every head, the LSP head included, so a `didCloseDocument` added in a
 * subclass would build the document twice. A change still debounced for the
 * document is dropped when the store releases it: the release handler rebuilds
 * the document from the file system provider or removes it.
 *
 * Adopters with their own handler subclass should extend this class
 * (not Langium's `DefaultDocumentUpdateHandler`) so all of them are
 * preserved. The {@link dispatch} hook is the canonical override
 * point for adopters that need to stamp additional per-build metadata.
 */
export class HydraniumDocumentUpdateHandler extends DefaultDocumentUpdateHandler {
   /**
    * Narrow Langium's `DefaultDocumentUpdateHandler.documentBuilder` typing to
    * the framework subclass: `scheduleUpdate` is the only method this handler
    * reaches for beyond the Langium interface.
    */
   declare protected readonly documentBuilder: HydraniumDocumentBuilder;

   protected readonly logger: Logger;
   protected readonly selfSaveRegistry: SelfSaveRegistry;
   protected readonly fileSystemProvider: WritableFileSystemProvider;
   protected readonly textDocuments: HydraniumTextDocuments<TextDocument>;

   /** Live debounce window — a constant or a setting-bound cell; read `.value` per flush. */
   protected readonly debounce: ObservableValue<number>;
   protected readonly bypassNonLanguageClientChanges: boolean;

   /** Accumulated changed / deleted URIs awaiting the next debounced flush. Keyed by URI string so duplicates merge. */
   protected pendingChanged = new Map<string, URI>();
   protected pendingDeleted = new Map<string, URI>();
   /** Trailing-edge timing for the coalesced flush; the pending sets above are the payload it drains. */
   protected readonly flushDebouncer: Debouncer;
   /** Flush on the next `fireDocumentUpdate` instead of debouncing — set by the LSP event handlers when the source isn't typing. */
   protected immediateFlush = false;

   /**
    * Build-reason for the next `fireDocumentUpdate`, stamped by the LSP
    * event overrides. `??=` semantics in `didChangeContent` preserve a
    * prior `'didOpen'` stamp because Langium fires `didOpen` then
    * `didChangeContent` on document open — the open semantics are the
    * authoritative trigger for that pair, not the content change.
    */
   protected nextReason?: string;
   /**
    * Build-reason captured at `fireDocumentUpdate` time, drained by
    * {@link dispatch} into the scheduled build. Survives across debounced
    * batches: `fireDocumentUpdate` replaces it with each event's reason, so a
    * coalesced burst carries its latest.
    */
   protected pendingReason?: string;

   protected readonly willSaveGateMs: number;
   /**
    * Per document URI, the release of the hold an editor's save in progress
    * keeps on the document's disk queue. A second save of the document
    * releases the first: its hold would otherwise keep the second's answer
    * waiting until the cap. The key is the document, not the save, so for a
    * client that sends its next `willSaveWaitUntil` before the previous
    * `didSave`, that late `didSave` releases the next save's hold.
    */
   protected readonly editorSaves = new Map<string, () => void>();

   constructor(
      protected readonly services: ServerSharedServices,
      options: HydraniumDocumentUpdateHandlerOptions = {}
   ) {
      super(services);
      this.logger = services.Logger;
      this.selfSaveRegistry = services.workspace.SelfSaveRegistry;
      this.fileSystemProvider = services.workspace.FileSystemProvider;
      this.textDocuments = services.workspace.TextDocuments;
      this.debounce = ObservableValue.from(options.debounceMs ?? 0);
      this.flushDebouncer = new Debouncer(services.Clock, () => this.flushPending(), { delayMs: this.debounce });
      this.bypassNonLanguageClientChanges = options.bypassNonLanguageClientChanges ?? true;
      this.willSaveGateMs = options.willSaveGateMs ?? 1000;
      this.textDocuments.onDidSaveInLanguageClient(event => this.editorSaves.get(event.uri)?.());
      services.workspace.VersionSyncService.registerDeferredBuilds(
         uri => this.pendingChanged.has(uri.toString()) || this.pendingDeleted.has(uri.toString())
      );
      // A change still debounced for a document the store has released would
      // build it once more after the release handler's build: from the
      // provider again, or, for a document the release removed, by reading a
      // file that is not there.
      this.textDocuments.onDidReleaseDocument(event => {
         this.pendingChanged.delete(URI.parse(event.uri).toString());
         if (this.pendingChanged.size === 0 && this.pendingDeleted.size === 0) {
            this.pendingReason = undefined;
         }
      });
   }

   didOpenDocument(_change: TextDocumentChangeEvent<TextDocument>): void {
      // Langium also fires `didChangeContent` on open, which is what triggers
      // `fireDocumentUpdate`. Stamp the reason here so the trailing
      // `didChangeContent` preserves it via `??=`. Bypass debouncing so the
      // LangiumDocument is in the index before consumers (model service,
      // form-editor, GLSP) try to read it.
      this.nextReason = HYDRANIUM_BUILD_REASONS.didOpen;
      this.immediateFlush = true;
   }

   override didChangeContent(change: TextDocumentChangeEvent<TextDocument>): void {
      // `??=` preserves a prior `'didOpen'` stamp (Langium fires didOpen
      // immediately before didChangeContent on document open).
      this.nextReason ??= HYDRANIUM_BUILD_REASONS.didChangeContent;
      // Bypass debouncing for non-Monaco author changes (GLSP node moves, form-editor
      // saves, integrity-rule mutations) — their producers already coalesce upstream.
      if (this.bypassNonLanguageClientChanges && this.textDocuments.getAuthor(change.document.uri) !== LANGUAGE_CLIENT_ID) {
         this.immediateFlush = true;
      }
      super.didChangeContent(change);
   }

   override didChangeWatchedFiles(params: DidChangeWatchedFilesParams): void {
      void this.filterSelfSaves(params)
         .then(filtered => {
            if (filtered.changes.length === 0) {
               return;
            }
            // Only an open document keeps the file's text as its disk
            // baseline; the store ignores the rest. The self-save filter has
            // dropped the server's own writes, which set the baseline when
            // they wrote.
            for (const change of filtered.changes) {
               this.textDocuments
                  .reloadDiskBaseline(change.uri)
                  .catch((err: unknown) => this.logger.error(`Disk baseline not reloaded for ${change.uri}. ${String(err)}`));
            }
            // External file-system changes are authoritative — overwrite any
            // pending reason (typically empty here; could be `didChangeContent`
            // if a watcher event raced an in-flight Monaco edit, in which case
            // the watcher event is the more interesting trigger to log).
            this.nextReason = HYDRANIUM_BUILD_REASONS.didChangeWatchedFiles;
            // External file-system changes are discrete events — flush immediately
            // rather than coalescing with in-flight Monaco typing.
            this.immediateFlush = true;
            super.didChangeWatchedFiles(filtered);
         })
         .catch(err => {
            // The rejection would otherwise reach the process-level
            // `unhandledRejection` listener, which reports neither the URIs nor
            // the fact that a watched-file rebuild was dropped — leaving the
            // workspace diverged from disk with no diagnostic and no retry.
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            const uris = params.changes.map(change => change.uri).join(', ');
            this.logger.error(`Watched-file update dropped for ${uris}. ${detail}`);
         });
   }

   /**
    * Answer an editor's `willSaveWaitUntil` with no edits once the server's
    * disk writes of the document already queued have landed, or after
    * {@link willSaveGateMs}, whichever is first. From the moment the queue
    * reaches this save, disk tasks of the document queued behind it wait for
    * the editor's `didSave`, reported through
    * `HydraniumTextDocuments.onDidSaveInLanguageClient`, or for
    * {@link willSaveGateMs} more.
    *
    * The hold is a disk task that waits only for that signal or its timer:
    * waiting on a build, a save or anything else queued for the document would
    * wedge its queue. Resolves in every case, since a failed request counts
    * against the listener in VS Code; Langium drops the request's cancellation,
    * so an abandoned request still runs to the cap. A hold that runs out is
    * logged at debug only: an editor skips `didSave` for a save it cancels or
    * that changed nothing.
    */
   willSaveDocumentWaitUntil(event: TextDocumentWillSaveEvent<TextDocument>): Promise<TextEdit[]> {
      const uri = event.document.uri;
      this.editorSaves.get(uri)?.();
      const hold = new Deferred();
      const release = (): void => {
         if (this.editorSaves.get(uri) === release) {
            this.editorSaves.delete(uri);
         }
         hold.resolve();
      };
      this.editorSaves.set(uri, release);
      return new Promise<TextEdit[]>(resolve => {
         const clock = this.services.Clock;
         const cap = clock.setTimer(() => {
            this.logger.warn(
               `willSaveWaitUntil for ${uri} answered after ${this.willSaveGateMs} ms with server writes of it still queued; the editor's save may race them.`
            );
            resolve([]);
         }, this.willSaveGateMs);
         try {
            void this.services.workspace.FileSystemTaskQueue.enqueue(uri, async () => {
               cap.dispose();
               resolve([]);
               if ((await clock.raceTimer(hold.promise, this.willSaveGateMs)) === TIMED_OUT) {
                  this.logger.debug(
                     `No didSave for ${uri} within ${this.willSaveGateMs} ms; server writes of it no longer wait for the editor's save.`
                  );
                  release();
               }
            });
         } catch (err) {
            cap.dispose();
            this.logger.error(
               `willSaveWaitUntil for ${uri} answered without waiting. ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
            );
            release();
            resolve([]);
         }
      });
   }

   /**
    * Present so that Langium advertises `save` and editors send `didSave`;
    * without it every hold of {@link willSaveDocumentWaitUntil} waits out its
    * cap. The hold is released on
    * `HydraniumTextDocuments.onDidSaveInLanguageClient` instead: it fires as
    * soon as the editor reports the save, while `onDidSave`, and so this
    * method, follows only once the file has been read back, and not at all
    * when the file does not hold the store's text.
    */
   didSaveDocument(_event: TextDocumentChangeEvent<TextDocument>): void {
      // Nothing to do; see the doc comment.
   }

   /**
    * Drop watched-file changes whose path + mtime match a recent self-save
    * record. Deletions always pass (no mtime); stat failures pass (the
    * change is real enough). Keyed by `fsPath` to avoid URI-form
    * mismatches between watcher payloads and write-time records. Stats run
    * in parallel — order in the output is irrelevant; the consumer
    * aggregates URIs into changed/deleted sets.
    */
   protected async filterSelfSaves(params: DidChangeWatchedFilesParams): Promise<DidChangeWatchedFilesParams> {
      const kept = await Promise.all(
         params.changes.map(async change => {
            if (change.type === FileChangeType.Deleted) {
               return change;
            }
            const uri = UriUtils.toUri(change.uri);
            const mtimeMs = await this.fileSystemProvider.mtimeMs?.(uri);
            if (mtimeMs !== undefined && this.selfSaveRegistry.isRegistered(uri.fsPath, mtimeMs)) {
               return undefined;
            }
            return change;
         })
      );
      return { changes: kept.filter((change): change is FileEvent => change !== undefined) };
   }

   /**
    * Coalesce `changed` / `deleted` into the pending sets, then either
    * flush immediately (`immediateFlush` or `debounceMs <= 0`) or restart
    * the trailing-edge timer. Subclasses that need to stamp per-build
    * metadata can override and inspect the merged sets — but the canonical
    * override point for the build is {@link dispatch}, not this method.
    */
   protected override fireDocumentUpdate(changed: URI[], deleted: URI[]): void {
      // Capture the reason set by the LSP event handler immediately before
      // we merge into the pending sets. Each event stamps its own reason, so
      // a coalesced burst carries its latest; `?? pendingReason` keeps the
      // earlier one only for a call no event stamped.
      this.pendingReason = this.nextReason ?? this.pendingReason;
      this.nextReason = undefined;
      for (const uri of changed) {
         this.pendingChanged.set(uri.toString(), uri);
      }
      for (const uri of deleted) {
         const key = uri.toString();
         this.pendingDeleted.set(key, uri);
         this.pendingChanged.delete(key);
      }
      if (this.immediateFlush || this.debounce.value <= 0) {
         this.immediateFlush = false;
         this.flushPending(); // cancels any armed flush, then drains
         return;
      }
      this.flushDebouncer.schedule();
   }

   /**
    * Drain the pending sets and dispatch a single build. Public so tests
    * can flush deterministically and shutdown paths can drain any
    * trailing-edge updates that would otherwise be lost when the timer
    * never fires.
    */
   public flushPending(): void {
      this.flushDebouncer.cancel();
      const changed = Array.from(this.pendingChanged.values());
      const deleted = Array.from(this.pendingDeleted.values());
      this.pendingChanged.clear();
      this.pendingDeleted.clear();
      if (changed.length === 0 && deleted.length === 0) {
         return;
      }
      this.dispatch(changed, deleted);
   }

   /**
    * Build the merged sets once the workspace is ready, through
    * {@link HydraniumDocumentBuilder.scheduleUpdate} with the pending reason,
    * so the build carries the LSP event that triggered it. A session's write
    * fires the store's change event before the session rebuilds the document
    * itself, and the scheduled build is what the two share.
    *
    * Adopters override to stamp additional per-build metadata: read the reason
    * via `this.pendingReason` and call `super.dispatch(...)`; the build may
    * be shared with other requests, so metadata stamped for it describes
    * theirs too. An override that needs code inside the write action takes
    * `workspaceLock.write` itself, as Langium's `fireDocumentUpdate` does, and
    * stages the reason through `markNextReason` there; its build then cancels
    * a scheduled one it coincides with rather than sharing it.
    */
   protected dispatch(changed: URI[], deleted: URI[]): void {
      const reason = this.pendingReason;
      this.pendingReason = undefined;
      this.workspaceManager.ready
         .then(() => this.documentBuilder.scheduleUpdate(changed, deleted, reason))
         .catch(err => {
            // A deferred rebuild can finish after the LSP peer has gone away.
            // Unless the head was started through `startLanguageServer`, whose
            // guard absorbs it, the diagnostics publish then fails this build:
            // a routine teardown race, not a failed workspace update. Keep
            // genuine update failures visible.
            if (isConnectionGoneError(err)) {
               return;
            }
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            this.logger.error(`Workspace initialization failed. Could not perform document update. ${detail}`);
         });
   }
}
