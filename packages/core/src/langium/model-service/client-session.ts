/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type BasedOn,
   ConflictError,
   isSnapshotVersion,
   Logger,
   type MaybeObservableValue,
   type MaybePromise,
   ObservableValue,
   type Tracer,
   type TransferElement,
   type TransferSaveArgs,
   type TransferUpdateAllArgs,
   type TransferUpdateArgs
} from '@hydranium/protocol';
import { type AstNode, UriUtils } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type AstDocument } from '../../documents/ast-document-manager.js';
import { DocumentNotOpenError, SessionClosedError } from '../../documents/client-session-errors.js';
import { type OpenOptions, type SessionEndCause } from '../../documents/client-session-registry.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServices } from '../module.js';
import { type AstDiagnostic } from '../validation/document-validator.js';
import { type ModelService } from './model-service.js';

/**
 * One participant's handle on the documents it works on, started by
 * `ModelService.createSession`.
 *
 * The session writes only what it has open: `update` and `save` fail with
 * `DocumentNotOpenError` unless this session has the URI open when the text is
 * applied, and the check and the apply are one synchronous step, so a write
 * either lands while the document is open or fails. A document stays open until
 * this session closes it, the session ends, or the file is deleted.
 *
 * One open per URI, without reference counting: opening a URI the session
 * already has open changes nothing, and one `close` ends it.
 *
 * After `dispose`, every other member throws `SessionClosedError`
 * synchronously, before returning a promise.
 *
 * Reads need no session and live on `ModelService`.
 */
export interface ClientSession<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TOpenOptions extends OpenOptions = OpenOptions
> {
   /** Unique in the process while the session is live: the author label on its writes and the key of its opens. */
   readonly clientId: string;
   readonly label: string;

   /**
    * Open `uri` for this session, reading it from disk unless some client has
    * it open already or it holds this client's unsaved text within its revert
    * grace. `options` are kept for this open until it closes; a repeat open,
    * concurrent or not, keeps the options of the first.
    */
   open(uri: string, options?: TOpenOptions): Promise<void>;
   /** The options this session opened `uri` with, or `undefined` when it gave none or does not have `uri` open. */
   openOptions(uri: string): TOpenOptions | undefined;
   /**
    * Create a document with `text` and open it for this session. It reaches
    * disk on the first `save`. Fails when the file exists, any client has the
    * URI open, or the URI waits out the revert grace, and of two creates of one
    * URI at most one succeeds.
    */
   create(uri: string, text: string): Promise<void>;
   update(args: Omit<TransferUpdateArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   /**
    * Write several documents this session has open, all or none: a
    * `ConflictError` or `DocumentNotOpenError` for any of them is thrown before
    * any text applies. Resolves to the rebuilt documents, in the order given.
    */
   updateAll(
      args: Omit<TransferUpdateAllArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>[]>;
   /** Write `args.model` as {@link update} does, then persist the document. */
   save(args: Omit<TransferSaveArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   /** Close this session's open of `uri`, at once. A no-op when it does not have `uri` open. */
   close(uri: string): Promise<void>;
   /**
    * Open `uri`, run `fn`, and close `uri` when `fn` settles, whether it
    * returned or threw. A URI the session already had open, or is still
    * opening through another call, stays open: the close undoes only the open
    * this call made.
    */
   withOpen<T>(uri: string, fn: () => MaybePromise<T>): Promise<T>;
   /** Whether an event's `sourceClientId` names this session, i.e. the event echoes its own write. */
   isOwnEcho(sourceClientId: string): boolean;
   /**
    * End the session: close everything it has open and free its id.
    * Idempotent. `cause` is `'lost'` when the session ends because its
    * client's connection went away, which lets each document it was the last
    * to have open wait out the store's revert grace; ending it for any other
    * reason reverts such a document at once.
    */
   dispose(cause?: SessionEndCause): void;
}

/**
 * The framework's {@link ClientSession}, built by
 * {@link DefaultClientSessionFactory}.
 *
 * Override the protected method behind a member to change how every session
 * writes, and return the subclass from a {@link ClientSessionFactory} bound on
 * `model.ClientSessionFactory`. Serialising a model and rebuilding a document
 * are the {@link ModelService}'s.
 *
 * An override of {@link dispose} calls `super.dispose(cause)`: that is what
 * closes the session's opens and frees its id, and dropping `cause` reverts
 * a lost client's documents without their grace.
 */
export class DefaultClientSession<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TOpenOptions extends OpenOptions = OpenOptions
> implements ClientSession<TAst, TDiagnostic, TTransfer, TOpenOptions> {
   protected disposed = false;
   /**
    * This session's opens still under way, by canonical URI. Recorded before
    * the first await, so a second open of the same URI joins the first rather
    * than racing it, and `withOpen` can tell an open another call is making.
    */
   protected readonly pendingOpens = new Map<string, Promise<void>>();
   /**
    * The options of this session's opens, by canonical URI. A first open
    * records its entry before the store has the URI open, and the entry goes
    * when that open closes, whoever ends it: this session, or the store for a
    * deleted file. A first open that fails never opens, so nothing closes it
    * and its entry stays until the next first open of the URI overwrites it;
    * {@link openOptions} therefore reads an entry only while the store has the
    * URI open for this session.
    */
   protected readonly openOptionsByUri = new Map<string, TOpenOptions | undefined>();
   /** Drops an open's options from {@link openOptionsByUri} when the store closes the open. */
   protected readonly closeListener: Disposable;
   /** Logs under `logName`, `ClientSession` when none is given, with this session's id in a bracket of its own, so a line names the session that wrote. */
   protected readonly tracer: Tracer;
   /** The service bound on `model.ModelService`, which serialises and rebuilds for this session. */
   protected readonly modelService: ModelService<TAst, TDiagnostic, TTransfer>;
   /** See {@link ClientSessionFactoryOptions.slowUpdateWarnMs}; `undefined` when not set. */
   protected readonly slowUpdateWarn?: ObservableValue<number>;
   readonly clientId: string;
   readonly label: string;

   constructor(
      protected readonly services: ServerSharedServices,
      options: ClientSessionOptions
   ) {
      this.clientId = options.clientId;
      this.label = options.label ?? options.clientId;
      // The slot is shared across grammars; this session's types hold for the
      // grammar that started it, as `createSession`'s narrowing does.
      this.modelService = services.model.ModelService as ModelService<TAst, TDiagnostic, TTransfer>;
      this.slowUpdateWarn = options.slowUpdateWarnMs !== undefined ? ObservableValue.from(options.slowUpdateWarnMs) : undefined;
      this.tracer = services.Tracer.for(options.logName ?? 'ClientSession').with(this.clientId);
      this.closeListener = services.workspace.TextDocuments.onDidClose(event => {
         if (event.clientId === this.clientId) {
            this.openOptionsByUri.delete(event.document.uri);
         }
      });
   }

   open(uri: string, options?: TOpenOptions): Promise<void> {
      this.assertLive();
      return this.openDocument(uri, options);
   }

   openOptions(uri: string): TOpenOptions | undefined {
      this.assertLive();
      return this.services.workspace.TextDocuments.isOpenInClient(uri, this.clientId)
         ? this.openOptionsByUri.get(this.canonicalKey(uri))
         : undefined;
   }

   create(uri: string, text: string): Promise<void> {
      this.assertLive();
      return this.createDocument(uri, text);
   }

   update(args: Omit<TransferUpdateArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      this.assertLive();
      return this.updateDocument(args, cancelToken);
   }

   updateAll(
      args: Omit<TransferUpdateAllArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>[]> {
      this.assertLive();
      return this.updateDocuments(args, cancelToken);
   }

   save(args: Omit<TransferSaveArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      this.assertLive();
      return this.saveDocument(args, cancelToken);
   }

   close(uri: string): Promise<void> {
      this.assertLive();
      return this.closeDocument(uri);
   }

   withOpen<T>(uri: string, fn: () => MaybePromise<T>): Promise<T> {
      this.assertLive();
      return this.runWithOpen(uri, fn);
   }

   isOwnEcho(sourceClientId: string): boolean {
      this.assertLive();
      return sourceClientId === this.clientId;
   }

   dispose(cause?: SessionEndCause): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.services.workspace.TextDocuments.closeSession(this.clientId, cause);
      this.closeListener.dispose();
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new SessionClosedError(this.clientId);
      }
   }

   /** Throw `DocumentNotOpenError` unless this session has `uri` open. */
   protected assertOpen(uri: string): void {
      if (!this.services.workspace.TextDocuments.isOpenInClient(uri, this.clientId)) {
         throw new DocumentNotOpenError(uri, this.clientId);
      }
   }

   /**
    * Throw `ConflictError` when `basedOn` names a version other than
    * `currentVersion`. A write calls it at the door and again in the
    * synchronous step that applies the text, and has to call it synchronously
    * there: a check separated from the apply by an await lets two writes based
    * on one version both apply.
    */
   protected assertBasedOn(uri: string, basedOn: BasedOn, currentVersion: number): void {
      if (isSnapshotVersion(basedOn) && currentVersion !== basedOn) {
         // Distinct from the post-build "superseded" debug line of an update: this
         // is a based-on-stale rejection (the write never applies), not two
         // writes racing.
         this.tracer.debug(`Conflict on ${uri}: based-on v${basedOn} stale, server at v${currentVersion}`);
         throw new ConflictError(uri, basedOn, currentVersion);
      }
   }

   /**
    * Serialise `args.model`, apply it to the store under this session's id,
    * rebuild, and resolve to the rebuilt document.
    *
    * The open check and the `basedOn` gate run at the door, so a write that
    * cannot land is refused before any adopter serialiser runs, and again in
    * the synchronous step that applies the text: made only before the
    * serialiser's await, a close during it lets the write land on a document
    * this session no longer has open, and two writes based on one version
    * both apply.
    *
    * Resolves with the latest build of the document, which may already carry
    * a newer write; that is logged at debug, and a slow update at warn when
    * `ClientSessionFactoryOptions.slowUpdateWarnMs` is set.
    */
   protected async updateDocument(
      args: Omit<TransferUpdateArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>> {
      const service = this.modelService;
      const slowWarn = this.slowUpdateWarn && { threshold: this.slowUpdateWarn, stopwatch: this.services.Clock.stopwatch() };
      // Canonical once at the door: the store keys every spelling of a file
      // to one registration.
      const uri = this.canonicalKey(args.uri);
      const profile = Logger.isLevelEnabled('debug') ? this.tracer.profile(`model-update ${uri}`) : undefined;
      const run = async <T>(stage: string, fn: () => MaybePromise<T>): Promise<T> => (profile ? profile.scope(stage, fn) : fn());
      const textDocuments = this.services.workspace.TextDocuments;
      this.assertOpen(uri);
      this.assertBasedOn(uri, args.basedOn, textDocuments.version(uri));
      const text = await run('serialize', () => service.modelToText(uri, args.model, cancelToken));
      const appliedVersion = await run('apply', () => {
         this.assertOpen(uri);
         this.assertBasedOn(uri, args.basedOn, textDocuments.version(uri));
         return this.services.workspace.AstDocumentManager.update(uri, text, this.clientId);
      });
      // Through the public `rebuild`, so an override of it stays in the path.
      // An override that awaits before calling the base can outlast the build
      // this write already has, and then builds it twice; see
      // `ModelService.rebuild`.
      const doc = await run('rebuild', () => service.rebuild(uri, undefined, cancelToken));
      const finalVersion = textDocuments.version(uri);
      if (finalVersion > appliedVersion) {
         this.tracer.debug(`Update to v${appliedVersion} ready at v${finalVersion} (superseded)`);
      } else {
         this.tracer.debug(`Update to v${appliedVersion} ready`);
      }
      if (slowWarn) {
         const elapsed = Math.round(slowWarn.stopwatch.elapsedMs);
         const threshold = slowWarn.threshold.value;
         if (elapsed >= threshold) {
            this.tracer.withUri(uri).warn(`Slow update: ${elapsed}ms ≥ ${threshold}ms (v${appliedVersion}, client=${this.clientId})`);
         }
      }
      profile?.report('debug');
      return doc;
   }

   /**
    * Write every document of `args.updates`, all or none: every model is
    * serialised first, then every open check and `basedOn` gate runs and every
    * text is applied in one synchronous step. Checked at the door as well, so
    * a stale set is refused before any adopter serialiser runs.
    *
    * The apply step relies on `AstDocumentManager.update` applying its text
    * before its first await, as the default does: an override that awaits first
    * lets another write land between two documents of the set.
    */
   protected async updateDocuments(
      args: Omit<TransferUpdateAllArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>[]> {
      const service = this.modelService;
      const { updates } = args;
      const textDocuments = this.services.workspace.TextDocuments;
      const uris = updates.map(update => this.canonicalKey(update.uri));
      if (new Set(uris).size !== uris.length) {
         throw new Error(`updateAll names a document more than once: ${uris.join(', ')}`);
      }
      const check = (): void =>
         updates.forEach((update, i) => {
            this.assertOpen(uris[i]);
            this.assertBasedOn(uris[i], update.basedOn, textDocuments.version(uris[i]));
         });
      check();
      const texts: string[] = [];
      for (const [i, update] of updates.entries()) {
         texts.push(await service.modelToText(uris[i], update.model, cancelToken));
      }
      // One synchronous step from the first check to the last apply: an await
      // anywhere in it lets a close or another write land after its document
      // was checked, and the set then half-applies before a later check fails.
      check();
      const applied = uris.map((uri, i) => this.services.workspace.AstDocumentManager.update(uri, texts[i], this.clientId));
      await Promise.all(applied);
      return Promise.all(uris.map(uri => service.rebuild(uri, undefined, cancelToken)));
   }

   /**
    * Write `args.model` through {@link updateDocument}, so an override of it
    * applies to saves too, then persist the document.
    *
    * Fails with `DocumentNotOpenError` and writes nothing when this session
    * closes the URI while the text is being built: the check sits in the same
    * synchronous step as the manager taking the text. Checked any earlier, a
    * session that closes the URI during the rebuild still has the shared
    * text, other clients' edits included, written in its name. Once taken,
    * the write completes whatever the session does next.
    */
   protected async saveDocument(
      args: Omit<TransferSaveArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>> {
      const doc = await this.updateDocument(args, cancelToken);
      const uri = this.canonicalKey(args.uri);
      this.assertOpen(uri);
      await this.services.workspace.AstDocumentManager.save(uri, this.clientId);
      return doc;
   }

   protected async closeDocument(uri: string): Promise<void> {
      await this.services.workspace.AstDocumentManager.close({ uri, clientId: this.clientId });
   }

   /** Open `uri`, or join the open of it this session already has under way, whose options then stand. */
   protected openDocument(uri: string, options: TOpenOptions | undefined): Promise<void> {
      const key = this.canonicalKey(uri);
      const pending = this.pendingOpens.get(key);
      if (pending) {
         return pending;
      }
      const opening = this.registerOpen(uri, options).finally(() => {
         if (this.pendingOpens.get(key) === opening) {
            this.pendingOpens.delete(key);
         }
      });
      this.pendingOpens.set(key, opening);
      return opening;
   }

   /**
    * Open `uri` in the store for this session. The open path does not thread
    * cancellation: the file read behind it takes no token, so a cancelled
    * caller still completes the open.
    *
    * A first open records its options before the store opens the URI, so a
    * listener of the store's open reads this open's options rather than an
    * earlier one's.
    */
   protected async registerOpen(uri: string, options: TOpenOptions | undefined): Promise<void> {
      const wasOpen = this.services.workspace.TextDocuments.isOpenInClient(uri, this.clientId);
      if (!wasOpen) {
         this.openOptionsByUri.set(this.canonicalKey(uri), options);
      }
      await this.services.workspace.AstDocumentManager.open({ uri, clientId: this.clientId });
      await this.rejectIfEnded(uri, wasOpen);
   }

   protected canonicalKey(uri: string): string {
      return this.services.workspace.DocumentUriPolicy.canonicalUri(uri);
   }

   protected async createDocument(uri: string, text: string): Promise<void> {
      if (await this.services.workspace.FileSystemProvider.exists(UriUtils.toUri(uri))) {
         throw new Error(`Cannot create ${uri}: the file exists`);
      }
      this.assertLive();
      if (this.services.workspace.TextDocuments.isRevertPending(uri)) {
         throw new Error(`Cannot create ${uri}: it holds the unsaved text of a lost client, waiting out the revert grace`);
      }
      if (this.modelService.isOpen(uri)) {
         throw new Error(`Cannot create ${uri}: it is open in a client`);
      }
      // The check above cannot see an open that registers while this one is
      // under way, and opening an already-open URI only attaches, dropping
      // `text`. Only an open that creates the document fires `onDidOpen`, so
      // hearing it for this session, during this open, is what proves the
      // document holds `text`; the client list afterwards cannot, since a
      // client that registered first may have closed again by then.
      const key = this.canonicalKey(uri);
      let created = false;
      const listener = this.services.workspace.TextDocuments.onDidOpen(event => {
         if (event.clientId === this.clientId && event.document.uri === key) {
            created = true;
         }
      });
      try {
         await this.services.workspace.AstDocumentManager.open({ uri, clientId: this.clientId, text });
      } finally {
         listener.dispose();
      }
      await this.rejectIfEnded(uri, false);
      if (!created) {
         await this.closeDocument(uri);
         throw new Error(`Cannot create ${uri}: it is open in a client`);
      }
   }

   protected async runWithOpen<T>(uri: string, fn: () => MaybePromise<T>): Promise<T> {
      // An open another call of this session is still making counts as made:
      // closing it afterwards would take away an open that call asked for.
      const alreadyOpen =
         this.services.workspace.TextDocuments.isOpenInClient(uri, this.clientId) || this.pendingOpens.has(this.canonicalKey(uri));
      await this.openDocument(uri, undefined);
      try {
         return await fn();
      } finally {
         if (!alreadyOpen && !this.disposed) {
            await this.closeDocument(uri);
         }
      }
   }

   /**
    * Undo an open that completed after the session ended, then fail it.
    *
    * Ending the session closed only what it had open at that moment. An open
    * still reading from disk registers afterwards, under an id that is no
    * longer a session, and nothing would ever close it.
    *
    * Opens are keyed by id, so once a new session holds the same id this open
    * is indistinguishable from one of its own, and closing it would close the
    * new session's. It is left to that session, which releases it at its end.
    */
   protected async rejectIfEnded(uri: string, wasOpen: boolean): Promise<void> {
      if (!this.disposed) {
         return;
      }
      if (!wasOpen && this.modelService.getSession(this.clientId) === undefined) {
         await this.closeDocument(uri);
      }
      throw new SessionClosedError(this.clientId);
   }
}

/** Constructor options for {@link DefaultClientSessionFactory}. */
export interface ClientSessionFactoryOptions extends LogNameOptions {
   /**
    * The name the factory and every session it builds log under, so one
    * option renames both. Default: `ClientSessionFactory` for the factory,
    * and `ClientSession` for a session, which adds its client id in a bracket
    * of its own.
    */
   readonly logName?: string;
   /**
    * When set, a session's `update` logs a `warn` line if its end-to-end wait
    * (serialise, apply, rebuild) takes at least this many milliseconds. Default
    * `undefined`: no warn line, and no per-update stopwatch.
    *
    * Observability only: the update is neither aborted nor resolved
    * differently. A hard timeout that throws is an override of
    * `DefaultClientSession.updateDocument` racing the parent call against a
    * deadline.
    *
    * A recommended starting threshold is 2-5 seconds; workspaces with very
    * large documents or slow validation can exceed 5 s on a cold build. A
    * `Settings.number` binding retunes it live.
    */
   readonly slowUpdateWarnMs?: MaybeObservableValue<number>;
}

/**
 * Constructor options for {@link DefaultClientSession}: the factory's options,
 * which it forwards, plus the session's identity.
 */
export interface ClientSessionOptions extends ClientSessionFactoryOptions {
   readonly clientId: string;
   /** What the session is. Pass one: the client id stands in for it otherwise. */
   readonly label?: string;
}

/**
 * Builds the handle for a session `ModelService.createSession` has already
 * registered, so registration and the uniqueness check cannot be skipped by
 * binding a factory of one's own. Bind one on `model.ClientSessionFactory` to
 * use a session class of your own. A factory that does not pass
 * {@link ClientSessionFactoryOptions.slowUpdateWarnMs} on to its sessions
 * loses their slow-update warn; subclassing {@link DefaultClientSessionFactory}
 * keeps it.
 *
 * Typed for every grammar, since the slot is shared: `createSession` narrows
 * the result to its caller's types.
 */
export interface ClientSessionFactory {
   create(clientId: string, label: string): ClientSession<AstNode>;
}

/**
 * The framework's {@link ClientSessionFactory}: a {@link DefaultClientSession}
 * over the {@link ModelService} bound on `model.ModelService`, which the session
 * serialises and rebuilds through. A model service constructed outside that
 * slot therefore starts sessions that write through the bound one.
 *
 * A subclass that overrides {@link create} to build a session class of its
 * own passes {@link options} on to that session's constructor; a session built
 * without them has no slow-update warn and logs under the default name.
 */
export class DefaultClientSessionFactory implements ClientSessionFactory {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServices,
      protected readonly options: ClientSessionFactoryOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? 'ClientSessionFactory').trace('instantiated');
   }

   create(clientId: string, label: string): ClientSession<AstNode> {
      return new DefaultClientSession(this.services, { ...this.options, clientId, label });
   }
}
