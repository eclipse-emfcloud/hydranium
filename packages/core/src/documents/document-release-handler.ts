/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type URI, UriUtils } from '@hydranium/langium';
import { type CanonicalUri, type Tracer } from '@hydranium/protocol';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { HYDRANIUM_BUILD_REASONS } from '../langium/document-builder/document-builder.js';
import { type ServerSharedServices } from '../langium/module.js';
import { isFileNotFound } from '../langium/workspace/file-not-found.js';
import { isConnectionGoneError } from '../util/connection-liveness.js';

/**
 * A document the store has released: no client holds its text any more. Its
 * queries read the store live, not a snapshot taken at the release.
 */
export interface ReleasedDocument {
   readonly uri: CanonicalUri;
   /** Whether `uri` names this document, under the store's own keying. */
   isFor(uri: string): boolean;
   /**
    * Whether a client took the document back: it holds it again, or it waits
    * out a new grace. Either way it is that client's, and the build keeps its text.
    */
   isReclaimed(): boolean;
}

/**
 * The rejection of a release skipped because the connection or the workspace
 * went away, with the error that showed it as `cause`. The store logs it at
 * debug, as routine at teardown, and any other rejection as an error.
 */
export class DocumentReleaseSkippedError extends Error {
   constructor(cause: unknown) {
      super(`Release skipped: the connection or the workspace went away. ${cause instanceof Error ? cause.message : String(cause)}`, {
         cause
      });
      this.name = 'DocumentReleaseSkippedError';
   }
}

/**
 * Whether `error` is a {@link DocumentReleaseSkippedError}, by name, so one
 * thrown by another installed copy of this package counts too.
 */
export function isDocumentReleaseSkippedError(error: unknown): error is DocumentReleaseSkippedError {
   return error instanceof Error && error.name === 'DocumentReleaseSkippedError';
}

/**
 * Decides what the build keeps for a document the store has released. Called
 * by the store at each release, for every head, after its release event.
 *
 * The returned promise settles the release: it resolves once the build holds
 * what it keeps for the document, and rejects when that build failed and may
 * still hold the released text. Until then, watchers keep a document released
 * dirty marked dirty. On a resolve the store announces it clean, naming the
 * store's last text while the build still has the document, and no text once
 * it has none; on a rejection, no text. The store logs a throw or rejection; reject with a
 * {@link DocumentReleaseSkippedError} for a release skipped at teardown.
 *
 * The data server announces the first build of a released document as the
 * release, so a handler that builds nothing leaves that to whichever build
 * comes next; one that carries a client's write keeps that client's name.
 *
 * Extend {@link DefaultDocumentReleaseHandler} to change only the policy: it
 * keeps the locking and the wait for the build. An implementation written
 * from scratch has to wait for that build itself before it resolves.
 */
export interface DocumentReleaseHandler {
   didReleaseDocument(released: ReleasedDocument): Promise<void>;
}

/** What the build does with a released document: rebuild it from its file, or remove it. */
export type DocumentReleaseDecision = 'rebuild' | 'remove';

/** How {@link DefaultDocumentReleaseHandler.runRelease} went. */
export type DocumentReleaseOutcome =
   /** A client took the document back: what the build keeps is that client's. */
   | { readonly kind: 'reclaimed' }
   /**
    * The lock resolved the write without running it, and the write that
    * cancelled it does not build this document. The framework's lock always
    * runs a cancelled write; a rebound `WorkspaceLock` may not.
    */
   | { readonly kind: 'discarded'; readonly decision: DocumentReleaseDecision }
   /** The build started and was cancelled; `parsed` when it parsed the document first. */
   | { readonly kind: 'cancelled'; readonly decision: DocumentReleaseDecision; readonly parsed: boolean }
   /** The decision was carried out. */
   | { readonly kind: 'completed'; readonly decision: DocumentReleaseDecision; readonly parsed: boolean }
   /** The decision or the build threw; `decision` is unset when deciding did. */
   | { readonly kind: 'failed'; readonly decision: DocumentReleaseDecision | undefined; readonly parsed: boolean; readonly error: unknown }
   /** The connection or the workspace went away: nothing more is built. `parsed` when the build parsed the document first. */
   | { readonly kind: 'skipped'; readonly parsed: boolean; readonly error: unknown };

/**
 * Rebuilds a released document from the file system provider, so the build
 * stops carrying the unsaved text of its last client. Override
 * `decideRelease` or `applyReleaseDecision` to change the policy and keep the
 * locking and the wait for the build.
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
 * Whether the document is still released is checked again inside the write
 * lock, as its holder: checked only before waiting for the lock, a client that
 * opens or re-creates the document meanwhile would have its text rebuilt over,
 * or the document removed. A document some client has open again, or that
 * waits out a new grace, is left to that client.
 *
 * The promise resolves once the revert has parsed the file, even if it is
 * then cancelled, or else once the build it requests in its place has parsed
 * it or removed the document. It rejects when that build fails, and when the
 * revert is skipped because the connection or the workspace went away before
 * it parsed the file, with a {@link DocumentReleaseSkippedError}.
 */
export class DefaultDocumentReleaseHandler implements DocumentReleaseHandler {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServices,
      options: LogNameOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   async didReleaseDocument(released: ReleasedDocument): Promise<void> {
      const target = UriUtils.toUri(released.uri);
      const outcome = await this.runRelease(released, target);
      this.tracer.with(released.uri).debug(`Release outcome: ${this.formatReleaseOutcome(outcome)}`);
      if (outcome.kind === 'skipped') {
         if (!outcome.parsed) {
            throw new DocumentReleaseSkippedError(outcome.error);
         }
         // The build holds the file's text: only what followed its parse, such as the diagnostics publish, was lost.
         const { error } = outcome;
         this.tracer
            .with(released.uri)
            .debug(`Revert on release skipped after its parse: ${error instanceof Error ? error.message : String(error)}`);
         return;
      }
      if (outcome.kind === 'failed') {
         const { error } = outcome;
         this.tracer
            .with(released.uri)
            .error(`Revert on release dropped. ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      const parsed = 'parsed' in outcome && outcome.parsed;
      // Without it, a revert stopped short, or an override that built nothing,
      // leaves the root on the released text. A failed one also lost the change
      // the update handler held back at the release; a document known to have
      // no file is removed, as the revert would have.
      const stoppedShort =
         ((outcome.kind === 'discarded' || outcome.kind === 'cancelled' || outcome.kind === 'completed') &&
            !parsed &&
            this.services.workspace.LangiumDocuments.getDocument(target) !== undefined) ||
         outcome.kind === 'failed';
      const recover = async (): Promise<void> => {
         const failure = 'Build after a revert that stopped short failed; the build keeps the released text';
         let built: boolean;
         try {
            built = await this.requestRecoveryBuild(released, target, 'decision' in outcome && outcome.decision === 'remove');
         } catch (err: unknown) {
            throw new Error(`${failure}. ${err instanceof Error ? err.message : String(err)}`, { cause: err });
         }
         if (!built) {
            throw new Error(failure);
         }
      };
      await this.waitForReleaseBuild(released, target, parsed, stoppedShort && !released.isReclaimed() ? recover : undefined);
   }

   /**
    * Decide, then carry the decision out under the write lock unless a client
    * holds the document again. Answers how that went; a parse of the document
    * seen meanwhile counts even when the build was cancelled after it, since
    * the build it yields to does not parse again.
    */
   protected async runRelease(released: ReleasedDocument, target: URI): Promise<DocumentReleaseOutcome> {
      const workspace = this.services.workspace;
      let decision: DocumentReleaseDecision | undefined;
      let parsed = false;
      let parses: Disposable | undefined;
      // Typed by assertion: the write's callback moves it, which narrowing does not see.
      let progress = 'queued' as 'queued' | 'reclaimed' | 'building' | 'built';
      try {
         // Decided before the lock: every build and read waits while the lock
         // is held, and the default decision waits on the file's save I/O.
         const decided = await this.decideRelease(released, target);
         decision = decided;
         await workspace.WorkspaceManager?.ready;
         // Queuing the write cancels the running build, even when it then reverts nothing.
         if (released.isReclaimed()) {
            return { kind: 'reclaimed' };
         }
         await workspace.WorkspaceLock.write(async token => {
            if (released.isReclaimed()) {
               progress = 'reclaimed';
               return;
            }
            parses = workspace.VersionSyncService.onDidRecordModel(document => {
               parsed ||= released.isFor(document.uri.toString());
            });
            progress = 'building';
            await this.applyReleaseDecision(target, decided, token);
            progress = 'built';
         });
         // A cancelled build throws inside the write, and the lock resolves.
         if (progress === 'reclaimed') {
            return { kind: 'reclaimed' };
         }
         if (progress === 'queued') {
            return { kind: 'discarded', decision: decided };
         }
         if (progress === 'building') {
            return { kind: 'cancelled', decision: decided, parsed };
         }
         return { kind: 'completed', decision: decided, parsed };
      } catch (error: unknown) {
         // A revert that finishes after the LSP peer went away fails its
         // diagnostics publish, and one that runs after its workspace was torn
         // down finds no file: teardown races, not failed reverts.
         if (isConnectionGoneError(error) || isFileNotFound(error, target)) {
            return { kind: 'skipped', parsed, error };
         }
         return { kind: 'failed', decision, parsed, error };
      } finally {
         parses?.dispose();
      }
   }

   /**
    * `outcome` for the line each release logs at debug: its kind, the
    * decision and whether the document was parsed.
    */
   protected formatReleaseOutcome(outcome: DocumentReleaseOutcome): string {
      if (outcome.kind === 'reclaimed') {
         return 'reclaimed by a client, built nothing';
      }
      const decision = 'decision' in outcome && outcome.decision !== undefined ? ` ${outcome.decision}` : '';
      const parsed = 'parsed' in outcome ? (outcome.parsed ? ', parsed' : ', not parsed') : '';
      return `${outcome.kind}${decision}${parsed}`;
   }

   /**
    * The policy: rebuild a document the file system provider can serve, and
    * remove any other. Read in the document's disk queue, so it follows any
    * save still queued rather than deciding past it.
    */
   protected decideRelease(released: ReleasedDocument, target: URI): Promise<DocumentReleaseDecision> {
      const workspace = this.services.workspace;
      return workspace.FileSystemTaskQueue.enqueue(released.uri, async () =>
         (await workspace.FileSystemProvider.exists(target)) ? 'rebuild' : 'remove'
      );
   }

   /**
    * Carry `decision` out under the write lock; a file gone since the decision
    * is removed instead. An override must rebuild or remove the document:
    * release settlement waits for its parse or removal, and one that does
    * neither is followed by a recovery build that rebuilds it.
    */
   protected async applyReleaseDecision(target: URI, decision: DocumentReleaseDecision, token: CancellationToken): Promise<void> {
      const builder = this.services.workspace.DocumentBuilder;
      builder.markNextReason(HYDRANIUM_BUILD_REASONS.didRelease);
      try {
         await (decision === 'rebuild' ? builder.update([target], [], token) : builder.update([], [target], token));
      } catch (err: unknown) {
         if (decision !== 'rebuild' || !isFileNotFound(err, target)) {
            throw err;
         }
         this.tracer.with(target.toString()).debug('Revert found no file; removing the document instead');
         builder.markNextReason(HYDRANIUM_BUILD_REASONS.didRelease);
         await builder.update([], [target], token);
      }
   }

   /** The build in place of a release that stopped short; answers whether it ran. */
   protected requestRecoveryBuild(released: ReleasedDocument, target: URI, deleted: boolean): Promise<boolean> {
      return this.services.workspace.VersionSyncService.requestRecoveryBuild(target, {
         deleted,
         reason: HYDRANIUM_BUILD_REASONS.didRelease,
         // The update handler dropped the change it held back at the release.
         ignoreDeferred: true,
         stillNeeded: () => !released.isReclaimed()
      });
   }

   /**
    * Resolve now when the build holds the file's text of `target` or no longer
    * has it, else once a parse or removal of `target` reaches the store:
    * settled with the released text still in the build, the release would name
    * that text. `startRecovery` requests the build in place of a revert that
    * stopped short, started only once the parse and removal are watched, so a
    * build that records the document at once is not missed. Rejects when that
    * build fails, since no parse or removal is coming then.
    */
   protected waitForReleaseBuild(
      released: ReleasedDocument,
      target: URI,
      parsed: boolean,
      startRecovery: (() => Promise<void>) | undefined
   ): Promise<void> {
      const workspace = this.services.workspace;
      // A client holding the document again keeps what the build holds for it.
      if (parsed || workspace.LangiumDocuments.getDocument(target) === undefined || released.isReclaimed()) {
         // Settled now, so a failed recovery build is only logged.
         startRecovery?.().catch((err: unknown) => this.tracer.with(released.uri).error(err instanceof Error ? err.message : String(err)));
         return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
         let ended = false;
         const finish = (end: () => void): void => {
            if (ended) {
               return;
            }
            ended = true;
            parses.dispose();
            removals.dispose();
            end();
         };
         const parses = workspace.VersionSyncService.onDidRecordModel(document => {
            if (released.isFor(document.uri.toString())) {
               finish(resolve);
            }
         });
         const removals = workspace.DocumentBuilder.onUpdate((_changed, deleted) => {
            if (deleted.some(uri => released.isFor(uri.toString()))) {
               finish(resolve);
            }
         });
         startRecovery?.().then(
            // A recovery build no longer needed, for a reclaimed document, builds nothing.
            () => {
               if (released.isReclaimed()) {
                  finish(resolve);
               }
            },
            (err: unknown) => {
               // Settled by a parse that came first, so only logged.
               if (ended) {
                  this.tracer.with(released.uri).error(err instanceof Error ? err.message : String(err));
               } else {
                  finish(() => reject(err));
               }
            }
         );
      });
   }
}
