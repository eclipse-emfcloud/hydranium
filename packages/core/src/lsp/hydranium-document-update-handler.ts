/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Debouncer, type Logger, ObservableValue, type MaybeObservableValue } from '@hydranium/protocol';
import { URI, UriUtils } from '@hydranium/langium';
import { DefaultDocumentUpdateHandler } from '@hydranium/langium/lsp';
import { type HydraniumDocumentBuilder } from '../langium/document-builder/document-builder.js';
import { type ServerSharedServices } from '../langium/module.js';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import { type SelfSaveRegistry } from '../documents/self-save-registry.js';
import { type WritableFileSystemProvider } from '../documents/ast-document-manager.js';
import { type HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';
import { type DidChangeWatchedFilesParams, type FileEvent, FileChangeType, type TextDocumentChangeEvent } from 'vscode-languageserver';
import { type TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Default LSP-event reasons stamped by {@link HydraniumDocumentUpdateHandler}
 * onto the next `documentBuilder.update` call via `markNextReason`. Exposed
 * so adopters subclassing the handler can layer additional reasons or rename
 * existing ones without losing the canonical names the framework emits.
 */
export const HYDRANIUM_BUILD_REASONS = Object.freeze({
   didOpen: 'didOpen',
   didChangeContent: 'didChangeContent',
   didChangeWatchedFiles: 'didChangeWatchedFiles',
   didClose: 'didClose'
} as const);

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
 *     (`didOpenDocument`, `didChangeContent`, `didChangeWatchedFiles`,
 *     `didCloseDocument`) populate {@link nextReason} with a canonical
 *     reason string. {@link fireDocumentUpdate} captures the reason;
 *     {@link dispatch} stages it on the builder via
 *     {@link HydraniumDocumentBuilder.markNextReason}, so a subclass that
 *     formats build logs can tag its line with the event that caused the
 *     build without per-adopter wiring to capture it.
 *  4. **Last-client-close rebuild trigger** ({@link didCloseDocument}) —
 *     when the final client closes a document, dispatch a build so the
 *     LangiumDocument's `textDocument` is refreshed (from disk for `file:`
 *     URIs, or removed from the index for ephemeral URIs). Langium's
 *     default handler does not implement `didCloseDocument`, so the
 *     in-memory text of the last writer would otherwise persist.
 *
 * Adopters with their own handler subclass should extend this class
 * (not Langium's `DefaultDocumentUpdateHandler`) so all of them are
 * preserved. The {@link dispatch} hook is the canonical override
 * point for adopters that need to stamp additional per-build metadata
 * inside the workspace-lock callback.
 */
export class HydraniumDocumentUpdateHandler extends DefaultDocumentUpdateHandler {
   /**
    * Narrow Langium's `DefaultDocumentUpdateHandler.documentBuilder` typing to
    * the framework subclass: `markNextReason` is the only method this handler
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
    * {@link dispatch} into `markNextReason`. Survives across debounced
    * batches (`?? pendingReason` in `fireDocumentUpdate` retains the
    * first reason in a coalesced burst).
    */
   protected pendingReason?: string;

   constructor(services: ServerSharedServices, options: HydraniumDocumentUpdateHandlerOptions = {}) {
      super(services);
      this.logger = services.Logger;
      this.selfSaveRegistry = services.workspace.SelfSaveRegistry;
      this.fileSystemProvider = services.workspace.FileSystemProvider;
      this.textDocuments = services.workspace.TextDocuments;
      this.debounce = ObservableValue.from(options.debounceMs ?? 0);
      this.flushDebouncer = new Debouncer(services.Clock, () => this.flushPending(), { delayMs: this.debounce });
      this.bypassNonLanguageClientChanges = options.bypassNonLanguageClientChanges ?? true;
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

   /**
    * Last-client close is the missing rebuild trigger in Langium's
    * `DefaultDocumentUpdateHandler`: `documents.onDidClose` fires on every
    * per-client close, but the default handler ignores the event entirely.
    * For multi-client servers this leaves the LangiumDocument carrying the
    * unsaved in-memory `textDocument` of the last writer until something
    * else triggers a rebuild — integrity rules walking `langiumDocuments.all`
    * then see stale text long after the user discarded their edits.
    *
    * We funnel the last-client transition through the same dispatch path
    * the other LSP events use, so the rebuild gets debouncing, workspace
    * locking, build-reason stamping, and `markNextReason` for free. The
    * scheme split governs the `DocumentBuilder.update` shape:
    *
    *  - **`file:` URI** → `update([uri], [])`. Routes through
    *    `LangiumDocuments.invalidateDocument` (doc stays in the trie) and
    *    `LangiumDocumentFactory.update`, which consults the LSP-tracked
    *    open-documents map first. That map is cleared LATER in the same
    *    synchronous `notifyDidCloseTextDocument` call that fires this event,
    *    and {@link dispatch} defers the build behind `workspaceManager.ready`
    *    — so by the time the factory looks, the URI is gone: it falls back to
    *    `FileSystemProvider.readFile` and the doc rebuilds from disk,
    *    Langium's canonical close-without-save semantic. A dispatch made
    *    synchronously here would still see the open document and re-read the
    *    in-memory text instead.
    *  - **non-`file:` URI** (`builtin:`, `untitled:`) → no dispatch.
    *    Adopter-loaded schemes — documents pulled in via
    *    `loadAdditionalDocuments` — need to stay in the workspace index;
    *    dropping them on close would break every cross-reference that
    *    targets them. The framework cannot enumerate adopter schemes, so the
    *    safe default is "leave alone unless it's a file." Adopters that need
    *    ephemeral-URI cleanup handle it explicitly.
    *
    * Per-client closes (where other clients still hold the URI) are
    * suppressed via {@link HydraniumTextDocuments.isOpenInAnyClient}.
    */
   didCloseDocument(change: TextDocumentChangeEvent<TextDocument>): void {
      if (this.textDocuments.isOpenInAnyClient(change.document.uri)) {
         return;
      }
      const uri = URI.parse(change.document.uri);
      if (uri.scheme !== 'file') {
         return;
      }
      this.nextReason = HYDRANIUM_BUILD_REASONS.didClose;
      this.immediateFlush = true;
      this.fireDocumentUpdate([uri], []);
   }

   override didChangeWatchedFiles(params: DidChangeWatchedFilesParams): void {
      void this.filterSelfSaves(params)
         .then(filtered => {
            if (filtered.changes.length === 0) {
               return;
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
            if (mtimeMs !== undefined && this.selfSaveRegistry.matches(uri.fsPath, mtimeMs)) {
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
    * override point for the workspace-lock callback is {@link dispatch},
    * not this method.
    */
   protected override fireDocumentUpdate(changed: URI[], deleted: URI[]): void {
      // Capture the reason set by the LSP event handler immediately before
      // we merge into the pending sets. `?? pendingReason` keeps the
      // first reason in a coalesced burst (LSP events arriving inside an
      // active debounce window all stamp the same `pendingReason` once,
      // because subsequent stamps see the field already non-undefined).
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
    * Workspace-lock + `documentBuilder.update` call for the merged sets.
    * Mirrors Langium's `super.fireDocumentUpdate` body plus
    * `markNextReason(pendingReason)` inside the write-lock callback, so the
    * build the lock is about to run carries the LSP event that triggered it.
    * Adopters override to stamp additional per-build metadata — the canonical
    * pattern is to read the reason via `this.pendingReason`, call
    * `super.dispatch(...)` or replicate the
    * `workspaceManager.ready -> workspaceLock.write` block, and add
    * adopter-specific behaviour inside the write callback.
    */
   protected dispatch(changed: URI[], deleted: URI[]): void {
      const reason = this.pendingReason;
      this.pendingReason = undefined;
      this.workspaceManager.ready
         .then(() =>
            this.workspaceLock.write(token => {
               this.documentBuilder.markNextReason(reason);
               return this.documentBuilder.update(changed, deleted, token);
            })
         )
         .catch(err => {
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            this.logger.error(`Workspace initialization failed. Could not perform document update. ${detail}`);
         });
   }
}
