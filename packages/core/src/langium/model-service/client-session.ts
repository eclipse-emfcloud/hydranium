/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type CloseModelArgs,
   type MaybePromise,
   type OpenModelArgs,
   type TransferElement,
   type TransferSaveArgs,
   type TransferUpdateAllArgs,
   type TransferUpdateArgs
} from '@hydranium/protocol';
import { type AstNode, UriUtils } from '@hydranium/langium';
import { type CancellationToken } from 'vscode-languageserver';
import { type AstDocument } from '../../documents/ast-document-manager.js';
import { SessionClosedError } from '../../documents/client-session-errors.js';
import { type OpenOptions, type SessionEndCause } from '../../documents/client-session-registry.js';
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
 * The writes a {@link DefaultClientSession} makes, each under the session's
 * own client id. The model service's own open, close and write methods are
 * protected, so this is the only way to reach them.
 */
export interface ClientSessionWriter<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic,
   TTransfer extends TransferElement = TransferElement
> {
   open(args: OpenModelArgs): Promise<void>;
   close(args: CloseModelArgs): Promise<void>;
   update(args: TransferUpdateArgs<TTransfer>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
   updateAll(args: TransferUpdateAllArgs<TTransfer>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>[]>;
   save(args: TransferSaveArgs<TTransfer>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>>;
}

/**
 * The framework's {@link ClientSession}, built by
 * `DefaultModelService.newSession`.
 *
 * Opens and writes go through `writer`, which `DefaultModelService` binds to
 * its own protected methods, so its overrides apply to every session's writes.
 * The open rule is enforced there, not here, because only the service reaches
 * the point where the text is applied.
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

   constructor(
      protected readonly modelService: ModelService<TAst, TDiagnostic, TTransfer>,
      protected readonly writer: ClientSessionWriter<TAst, TDiagnostic, TTransfer>,
      protected readonly services: ServerSharedServices,
      readonly clientId: string,
      readonly label: string
   ) {}

   open(uri: string, options?: TOpenOptions): Promise<void> {
      this.assertLive();
      return this.openDocument(uri, options);
   }

   create(uri: string, text: string): Promise<void> {
      this.assertLive();
      return this.createDocument(uri, text);
   }

   update(args: Omit<TransferUpdateArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      this.assertLive();
      return this.writer.update({ ...args, clientId: this.clientId }, cancelToken);
   }

   updateAll(
      args: Omit<TransferUpdateAllArgs<TTransfer>, 'clientId'>,
      cancelToken?: CancellationToken
   ): Promise<AstDocument<TAst, TDiagnostic>[]> {
      this.assertLive();
      return this.writer.updateAll({ ...args, clientId: this.clientId }, cancelToken);
   }

   save(args: Omit<TransferSaveArgs<TTransfer>, 'clientId'>, cancelToken?: CancellationToken): Promise<AstDocument<TAst, TDiagnostic>> {
      this.assertLive();
      return this.writer.save({ ...args, clientId: this.clientId }, cancelToken);
   }

   close(uri: string): Promise<void> {
      this.assertLive();
      return this.writer.close({ uri, clientId: this.clientId });
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
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new SessionClosedError(this.clientId);
      }
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

   protected async registerOpen(uri: string, options: TOpenOptions | undefined): Promise<void> {
      const textDocuments = this.services.workspace.TextDocuments;
      const wasOpen = textDocuments.isOpenInClient(uri, this.clientId);
      await this.writer.open({ uri, clientId: this.clientId });
      await this.rejectIfEnded(uri, wasOpen);
      if (!wasOpen && options !== undefined) {
         textDocuments.setOpenOptions(uri, this.clientId, options);
      }
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
         await this.writer.open({ uri, clientId: this.clientId, text });
      } finally {
         listener.dispose();
      }
      await this.rejectIfEnded(uri, false);
      if (!created) {
         await this.writer.close({ uri, clientId: this.clientId });
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
            await this.writer.close({ uri, clientId: this.clientId });
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
         await this.writer.close({ uri, clientId: this.clientId });
      }
      throw new SessionClosedError(this.clientId);
   }
}
