/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DocumentState, type LangiumDocument, type URI } from '@hydranium/langium';
import { type Tracer, UNRECORDED_VERSION } from '@hydranium/protocol';
import { Disposable, Emitter, type Event } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { type ServerSharedServices } from '../langium/module.js';
import { HydraniumWorkspaceLock } from '../langium/workspace/hydranium-workspace-lock.js';
import { HydraniumTextDocuments } from './hydranium-text-documents.js';

/** A build {@link VersionSyncService.requestRecoveryBuild} schedules. */
export interface RecoveryBuildRequest {
   /** Remove the document instead of building it. */
   readonly deleted?: boolean;
   /** Staged for the build, as `HydraniumDocumentBuilder.scheduleUpdate` takes it. */
   readonly reason?: string;
   /** Asked again inside the lock, where a build that ran meanwhile may have made the request moot. */
   readonly stillNeeded: () => boolean;
   /** Build even while a {@link VersionSyncService.registerDeferredBuilds} check holds the URI back. */
   readonly ignoreDeferred?: boolean;
}

/**
 * Keeps each workspace root's `ModelLedger` record in step with the
 * text store, and owns every build that syncs a root to its text or recovers
 * one a build left behind.
 */
export interface VersionSyncService {
   /**
    * Report a root a factory, registry, integrity repair or other producer
    * made. Below `Parsed` it is marked a placeholder. Otherwise `origin.version`,
    * the store's version read before the parse, is recorded; a registered
    * document is then reconciled with the store, re-versioned and recorded at
    * the store's version of its text, built if behind, and announced on
    * {@link onDidRecordModel}. `origin.text` stands for a root whose CST is not
    * the text it describes.
    */
   modelProduced(document: LangiumDocument, origin?: { version?: number; text?: string }): void;
   /**
    * Build `uri` from a `WorkspaceLock` read, so the build queues behind a
    * running one rather than cancelling it. Requests made while one for `uri`
    * is pending share its next build. Resolves `true` once a build that carried
    * this request completed, or once a check before a build found it no longer
    * needed or deferred. A build a later write cancelled does not count: the
    * request rides the next one. Resolves `false` once builds carrying this
    * request have failed more often than it may retry, so a caller waiting on
    * the build can stop. Never rejects.
    */
   requestRecoveryBuild(uri: URI, request: RecoveryBuildRequest): Promise<boolean>;
   /**
    * Build `uri` unless it is {@link isSyncedTo synced to} `textVersion`, asked
    * again inside the lock. `undefined` when no build is needed, else the
    * {@link requestRecoveryBuild} answer.
    */
   syncTo(uri: URI, textVersion: number): Promise<boolean> | undefined;
   /**
    * Whether `uri`'s root was parsed from text at `textVersion` or later; requests
    * nothing. A root with no recorded version or a placeholder counts as synced,
    * since no build records a version for it, and so does a URI with no document.
    */
   isSyncedTo(uri: URI, textVersion: number): boolean;
   /**
    * Register `isDeferred`, which answers whether its caller holds back a build
    * of a URI it will request later, as the update handler does for a debounced
    * editor change. A caller that drops a held change has to leave the URI to
    * another build.
    */
   registerDeferredBuilds(isDeferred: (uri: URI) => boolean): Disposable;
   /**
    * Fires for every reconciled root. A cancel cannot skip it, unlike a
    * `Parsed` phase listener. It can fire inside a build's write lock, so a
    * listener that requests a build must not await it.
    */
   readonly onDidRecordModel: Event<LangiumDocument>;
}

/** A request waiting in {@link PendingRecoveryBuilds}, with the failed builds that carried it. */
export interface QueuedRecoveryBuild {
   readonly request: RecoveryBuildRequest;
   failures: number;
   readonly answer: (built: boolean) => void;
}

/** The requests waiting on one URI's builds in {@link DefaultVersionSyncService}. */
export interface PendingRecoveryBuilds {
   readonly queued: QueuedRecoveryBuild[];
}

/**
 * Collaborators are resolved per call: the registry and its document factory,
 * which construct each other, report roots to this service.
 */
export class DefaultVersionSyncService implements VersionSyncService {
   protected readonly tracer: Tracer;
   protected readonly recordedEmitter = new Emitter<LangiumDocument>();
   protected readonly deferredBuildChecks = new Set<(uri: URI) => boolean>();
   protected readonly pendingBuilds = new Map<string, PendingRecoveryBuilds>();
   /** Retries of each request after a failed build before it is answered `false`. */
   protected readonly maxBuildRetries: number = 1;

   constructor(
      protected readonly services: ServerSharedServices,
      options: LogNameOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? 'VersionSyncService').trace('instantiated');
   }

   get onDidRecordModel(): Event<LangiumDocument> {
      return this.recordedEmitter.event;
   }

   modelProduced(document: LangiumDocument, origin: { version?: number; text?: string } = {}): void {
      const workspace = this.services.workspace;
      const ledger = workspace.ModelLedger;
      const root = document.parseResult.value;
      if (document.state < DocumentState.Parsed) {
         ledger.markPlaceholder(root);
         return;
      }
      if (origin.version !== undefined) {
         ledger.record(root, origin.version, origin.text);
      }
      const store = workspace.TextDocuments;
      // Unregistered, it is a probe or a load whose registration reports it again.
      if (!(store instanceof HydraniumTextDocuments) || workspace.LangiumDocuments.getDocument(document.uri) !== document) {
         return;
      }
      const uri = document.uri.toString();
      // Against the parsed text: the text document may already hold a newer edit.
      const version = store.reconcileExternalContent(uri, origin.text ?? this.parsedText(document));
      if (version !== undefined) {
         if (document.textDocument.version !== version) {
            // An empty-changes update only re-stamps the version.
            store.update(document.textDocument, [], version);
         }
         ledger.record(root, version, origin.text);
      }
      void this.syncTo(document.uri, store.version(uri));
      this.recordedEmitter.fire(document);
   }

   syncTo(uri: URI, textVersion: number): Promise<boolean> | undefined {
      const behind = (): boolean => !this.isSyncedTo(uri, textVersion);
      return behind() ? this.requestRecoveryBuild(uri, { stillNeeded: behind }) : undefined;
   }

   requestRecoveryBuild(uri: URI, request: RecoveryBuildRequest): Promise<boolean> {
      return new Promise<boolean>(answer => {
         const key = uri.toString();
         const queued: QueuedRecoveryBuild = { request, failures: 0, answer };
         const pending = this.pendingBuilds.get(key);
         if (pending) {
            // Not dropped: the pending build may have read the text before this request's change.
            pending.queued.push(queued);
            return;
         }
         const entry: PendingRecoveryBuilds = { queued: [queued] };
         this.pendingBuilds.set(key, entry);
         void this.runBuilds(key, uri, entry);
      });
   }

   registerDeferredBuilds(isDeferred: (uri: URI) => boolean): Disposable {
      this.deferredBuildChecks.add(isDeferred);
      return Disposable.create(() => this.deferredBuildChecks.delete(isDeferred));
   }

   isSyncedTo(uri: URI, textVersion: number): boolean {
      const root = this.services.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
      if (root === undefined) {
         return true;
      }
      const ledger = this.services.workspace.ModelLedger;
      const recorded = ledger.versionOf(root);
      return recorded === UNRECORDED_VERSION || ledger.isPlaceholder(root) || recorded >= textVersion;
   }

   /** The text `document`'s root was parsed from, or for a root built without either record or CST, the document's own. */
   protected parsedText(document: LangiumDocument): string {
      return this.services.workspace.ModelLedger.textOf(document.parseResult.value) ?? document.textDocument.getText();
   }

   /**
    * Run `entry`'s requests, one build per batch, until none is queued, and
    * answer each. A request a failed build carried is queued again
    * {@link maxBuildRetries} times, then answered `false`; one a cancelled
    * build carried is queued again without counting. The entry is dropped
    * in the same tick as the last check of the queue, so no request lands in
    * an entry nothing runs any more.
    */
   protected async runBuilds(key: string, uri: URI, entry: PendingRecoveryBuilds): Promise<void> {
      const tracer = this.tracer.withUri(key);
      const lock = this.services.workspace.WorkspaceLock;
      // Any other lock resolves a cancelled write as if it had completed, unnoticed.
      const counting = lock instanceof HydraniumWorkspaceLock ? lock : undefined;
      while (entry.queued.length > 0) {
         let carried: QueuedRecoveryBuild[] = [];
         let build: Promise<void> | undefined;
         let cancellations: number | undefined;
         try {
            // The read waits until no write runs or is queued. It must not await
            // the build, a write that queues behind it.
            await lock.read(() => {
               carried = entry.queued.splice(0);
               const needed = carried.filter(queued => this.isStillNeeded(uri, queued.request));
               carried.filter(queued => !needed.includes(queued)).forEach(queued => queued.answer(true));
               carried = needed;
               if (needed.length > 0) {
                  build = this.scheduleBatch(
                     uri,
                     needed.map(queued => queued.request)
                  );
                  // Read after the build is queued, which cancels the write before it.
                  cancellations = counting?.writeCancellations;
               }
            });
            await build;
            // A write cancelled the build, before it ran or while it did.
            if (cancellations !== undefined && counting?.writeCancellations !== cancellations) {
               entry.queued.unshift(...carried);
               continue;
            }
            carried.forEach(queued => queued.answer(true));
         } catch (err: unknown) {
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            const retried = carried.filter(queued => queued.failures++ < this.maxBuildRetries);
            const givenUp = carried.filter(queued => !retried.includes(queued));
            if (retried.length > 0) {
               tracer.warn(`Requested build failed; retrying. ${detail}`);
               entry.queued.unshift(...retried);
            }
            if (givenUp.length > 0) {
               tracer.error(`Requested build failed again; giving up. ${detail}`);
               givenUp.forEach(queued => queued.answer(false));
            }
         }
      }
      this.pendingBuilds.delete(key);
   }

   /** Whether `request` still needs its build, and no deferral it heeds holds it back. Runs inside the lock read. */
   protected isStillNeeded(uri: URI, request: RecoveryBuildRequest): boolean {
      return request.stillNeeded() && (request.ignoreDeferred === true || !this.isDeferred(uri));
   }

   /**
    * One build for every request of `batch`, removing the document when the
    * latest of them asks to, as `HydraniumDocumentBuilder.scheduleUpdate`
    * merges a change and a deletion. Runs inside the lock read.
    */
   protected scheduleBatch(uri: URI, batch: readonly RecoveryBuildRequest[]): Promise<void> {
      const deleted = batch.at(-1)?.deleted === true;
      const reason = batch.find(request => request.reason !== undefined)?.reason;
      return this.services.workspace.DocumentBuilder.scheduleUpdate(deleted ? [] : [uri], deleted ? [uri] : [], reason);
   }

   protected isDeferred(uri: URI): boolean {
      return [...this.deferredBuildChecks].some(isDeferred => isDeferred(uri));
   }
}
