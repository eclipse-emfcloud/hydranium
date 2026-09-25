/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerProtocol, DiagnosticOf } from '../data';
import type { SnapshotVersion } from '../model-service/based-on';
import { type ResolvedMessage, defineMessage, describeError, resolve } from '../messages/primitives';
import type { OpenModelArgs } from '../model-server';
import type { MaybePromise } from '../util';
import type { RpcProxy } from '../rpc';
import type { TransferDocument } from '../transfer-document';
import type { TransferElement } from '../transfer-element';

/**
 * A session could not re-open a document it had open after its connection
 * dropped.
 */
export const DATA_SESSION_RESTORE_FAILED = defineMessage(
   'hydranium/protocol/data-session-restore-failed',
   'Could not restore {uri} after reconnecting to the data server: {detail}'
);

/**
 * A session re-opened documents after its connection dropped whose version had
 * moved on since the session's last unsaved write to them: another client
 * edited them, even while the session was still connected, the server reverted
 * them to what is on disk, or the server restarted. The session's unsaved edits
 * may be gone.
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
 * URI and the open's options: a session's open reads the file, and the server
 * ignores the `languageId`, `version` and `text` seeds of `OpenModelArgs`, so
 * accepting them here would let a caller believe they took effect.
 */
export type DataSessionOpenArgs<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = Pick<OpenModelArgs, 'uri' | 'options'>;

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

/** The document a session hands back, carrying its server's diagnostic shape. */
export type DataSessionDocument<
   TTransfer extends TransferElement,
   TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>> = DataServerProtocol<TTransfer>
> = TransferDocument<TTransfer, DiagnosticOf<TServer>>;

/**
 * What a {@link DataSession} needs from the connection that minted it.
 *
 * Narrower than the connection itself so the dependency points one way:
 * `DataConnection` constructs sessions, and nothing here imports it back.
 */
export interface DataSessionHost<TTransfer extends TransferElement, TServer extends DataServerProtocol<TTransfer, DiagnosticOf<TServer>>> {
   /** The connected, READY proxy of the current connection; a new object after each reconnect. */
   connected(): Promise<RpcProxy<TServer>>;
   releaseSession(session: DataSession<TTransfer, TServer>): void;
   /** Surface a failure no caller is waiting on, such as restoring a document after a reconnect. */
   reportError?(error: unknown, reported: ResolvedMessage): void;
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
 * {@link closeDocument} and {@link dispose} first wait, up to
 * {@link settleBeforeCloseMs}, for this session's calls still in flight on the
 * URI, or on any URI for `dispose`: a save sent just before its close would
 * otherwise reach the server after it, and fail as not open.
 *
 * After the connection drops, the session registers again under the same id,
 * re-opens and re-watches what it had open, and reports the documents whose
 * unsaved edits did not survive; see {@link restore}. The connection does this at
 * once for a session with documents open, and any session's next call does it
 * too.
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
> {
   /**
    * How long {@link closeDocument} and {@link dispose} wait for this session's
    * calls in flight before closing anyway. Long, because the wait only runs
    * out when a call hangs, and a close sent while a save is still running
    * fails that save.
    */
   protected readonly settleBeforeCloseMs: number = 10_000;
   /** URIs this session has open, re-opened after a reconnect. */
   protected readonly openUris = new Set<string>();
   /**
    * Per URI, how many opens of it this session has under way. Such a URI
    * counts as open for {@link withOpenDocument}, which would otherwise close
    * it under the open that is still being made.
    */
   protected readonly openingUris = new Map<string, number>();
   /**
    * Per URI written since its last save, the version the server answered this
    * session's last write with; see {@link restore}.
    */
   protected readonly unsavedWrites = new Map<string, SnapshotVersion>();
   /** Per URI, this session's calls still in flight on it, which a close waits for. */
   protected readonly inFlight = new Map<string, Set<Promise<unknown>>>();
   /**
    * Sent with every registration, so the server lets this session register
    * its id again while the dropped connection's session is still live there:
    * a server that has not yet noticed the drop would otherwise refuse the id
    * as a duplicate until it does.
    */
   protected readonly resumeToken: string = globalThis.crypto.randomUUID();
   /** The proxy the session is registered on; another one means the connection was replaced. */
   protected registeredOn?: RpcProxy<TServer>;
   protected registration?: Promise<void>;
   protected disposed = false;
   /**
    * Disposed through {@link detach} rather than {@link dispose}, so nothing may
    * be sent. Folding it into {@link disposed} would send the session's close
    * over a connection that is going away.
    */
   protected detached = false;

   constructor(
      readonly clientId: string,
      protected readonly host: DataSessionHost<TTransfer, TServer>,
      readonly label: string
   ) {}

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
    * Note that the returned snapshot's empty `diagnostics` does not mean
    * valid: `open` settles at the integrity landmark, not at validation.
    * Validity arrives asynchronously on `onDocumentUpdated`, or synchronously
    * from `getModelDocument({ includeDiagnostics: true })`.
    */
   openDocument(args: DataSessionOpenArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.trackOpen(args.uri, async () => {
         const server = await this.connected();
         return this.watchOpened(server, args.uri, await server.openModelDocument({ ...args, clientId: this.clientId }));
      });
   }

   /**
    * Create a document that exists nowhere yet, open and watched for this
    * session; it reaches disk with the first {@link saveDocument}. The server
    * refuses a URI that exists on disk or that any client has open.
    */
   createDocument(args: DataSessionCreateArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.trackOpen(args.uri, async () => {
         const server = await this.connected();
         return this.watchOpened(server, args.uri, await server.createModelDocument({ ...args, clientId: this.clientId }));
      });
   }

   /**
    * Watch a document this session just opened, and record it as open. A
    * failed watch closes it again: the caller sees a failed open and so would
    * never close it.
    */
   protected async watchOpened(
      server: RpcProxy<TServer>,
      uri: string,
      document: DataSessionDocument<TTransfer, TServer>
   ): Promise<DataSessionDocument<TTransfer, TServer>> {
      try {
         await server.watchModelDocument({ uri, clientId: this.clientId });
      } catch (error: unknown) {
         await server.closeModelDocument({ uri, clientId: this.clientId }).catch(() => undefined);
         throw error;
      }
      this.openUris.add(uri);
      return document;
   }

   /**
    * Close `args.uri`, once this session's calls on it have settled or
    * {@link settleBeforeCloseMs} has passed. The server unwatches implicitly,
    * so this is the dual of {@link openDocument} and needs no separate unwatch.
    */
   async closeDocument(args: DataSessionCloseArgs<TTransfer, TServer>): Promise<void> {
      this.assertLive();
      await this.settle(this.inFlight.get(args.uri));
      // Forgotten before the close is sent, so a reconnect in between does not
      // re-open a document the caller has closed; after the wait, so an open
      // of it that was still in flight does not record it again.
      this.openUris.delete(args.uri);
      this.unsavedWrites.delete(args.uri);
      const server = await this.connected();
      await server.closeModelDocument({ ...args, clientId: this.clientId });
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
      const alreadyOpen = this.openUris.has(args.uri) || this.openingUris.has(args.uri);
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
      return this.track([args.uri], async () => {
         const server = await this.connected();
         const document = await server.updateModelDocument({ ...args, clientId: this.clientId });
         this.unsavedWrites.set(args.uri, document.version);
         return document;
      });
   }

   /**
    * Write several documents this session has open, all or none: the server
    * refuses the whole set, before any text applies, when one is stale or not
    * open. Resolves to the documents in the order given.
    */
   updateDocuments(args: DataSessionUpdatesArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>[]> {
      return this.track(
         args.updates.map(update => update.uri),
         async () => {
            const server = await this.connected();
            const documents = await server.updateModelDocuments({ ...args, clientId: this.clientId });
            args.updates.forEach((update, i) => this.unsavedWrites.set(update.uri, documents[i].version));
            return documents;
         }
      );
   }

   /** Persist `args.model` to disk as this session. The session must have `args.uri` open. */
   saveDocument(args: DataSessionSaveArgs<TTransfer, TServer>): Promise<DataSessionDocument<TTransfer, TServer>> {
      return this.track([args.uri], async () => {
         const server = await this.connected();
         const document = await server.saveModelDocument({ ...args, clientId: this.clientId });
         this.unsavedWrites.delete(args.uri);
         return document;
      });
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
    * Every later call rejects. The server close is not awaited, because a
    * `Disposable` cannot be; a close that fails leaves the session to the
    * server's connection-close cleanup.
    */
   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.host.releaseSession(this);
      const pending = [...this.inFlight.values()].flatMap(calls => [...calls]);
      void (async () => {
         await this.settle(pending);
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
    */
   detach(): void {
      this.disposed = true;
      this.detached = true;
      this.openUris.clear();
      this.unsavedWrites.clear();
   }

   /**
    * Register again and restore now, after the connection dropped, instead of
    * on the next call. A no-op for a session with nothing open, which the next
    * call restores anyway. A failure is left to that next call, which meets it
    * again.
    */
   reconnect(): void {
      if (!this.disposed && this.openUris.size > 0) {
         this.connected().catch(() => undefined);
      }
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
    * Re-open and re-watch every document the session had open, and tell the
    * host which of them lost what the session wrote since their last save.
    *
    * The unsaved text is not sent again. A document whose re-opened version is
    * the one the session's last write was answered with still holds that
    * write. Any other version means the text changed after that write:
    * another client edited it, even while the session was still connected;
    * the server reverted it to disk when the session's open closed as the
    * document's last; or the server restarted and numbers versions afresh.
    * Re-sending based on the write's own version then always conflicts, and
    * based on the re-opened version it would overwrite whatever changed, so
    * neither is done.
    *
    * No caller is waiting, so both outcomes go through the host: one report
    * naming every document whose unsaved text is gone, whose record is then
    * dropped, and one per document that could not be re-opened, which is
    * forgotten.
    */
   protected async restore(server: RpcProxy<TServer>): Promise<void> {
      const lost: string[] = [];
      for (const uri of [...this.openUris]) {
         try {
            const document = await server.openModelDocument({ uri, clientId: this.clientId });
            await server.watchModelDocument({ uri, clientId: this.clientId });
            const written = this.unsavedWrites.get(uri);
            if (written !== undefined && written !== document.version) {
               lost.push(uri);
               this.unsavedWrites.delete(uri);
            }
         } catch (error: unknown) {
            this.openUris.delete(uri);
            this.unsavedWrites.delete(uri);
            this.host.reportError?.(error, resolve(DATA_SESSION_RESTORE_FAILED, { uri, detail: describeError(error) }));
         }
      }
      if (lost.length > 0) {
         const reported = resolve(DATA_SESSION_UNSAVED_LOST, { uris: lost.join(', ') });
         this.host.reportError?.(new Error(reported.text), reported);
      }
   }

   /** Run `call`, counted as in flight on each of `uris` until it settles. */
   protected track<T>(uris: readonly string[], call: () => Promise<T>): Promise<T> {
      const running = call();
      for (const uri of uris) {
         this.inFlight.set(uri, (this.inFlight.get(uri) ?? new Set<Promise<unknown>>()).add(running));
      }
      const done = (): void => uris.forEach(uri => this.inFlight.get(uri)?.delete(running));
      running.then(done, done);
      return running;
   }

   /** {@link track} an open of `uri`, counted in {@link openingUris} until it settles. */
   protected trackOpen<T>(uri: string, call: () => Promise<T>): Promise<T> {
      this.openingUris.set(uri, (this.openingUris.get(uri) ?? 0) + 1);
      const done = (): void => {
         const remaining = (this.openingUris.get(uri) ?? 1) - 1;
         if (remaining > 0) {
            this.openingUris.set(uri, remaining);
         } else {
            this.openingUris.delete(uri);
         }
      };
      const running = this.track([uri], call);
      running.then(done, done);
      return running;
   }

   /** Wait until `calls` have settled, or {@link settleBeforeCloseMs} has passed. */
   protected async settle(calls: Iterable<Promise<unknown>> | undefined): Promise<void> {
      const pending = [...(calls ?? [])];
      if (pending.length === 0) {
         return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>(resolveBound => {
         timer = setTimeout(resolveBound, this.settleBeforeCloseMs);
      });
      try {
         await Promise.race([Promise.allSettled(pending), bound]);
      } finally {
         clearTimeout(timer);
      }
   }

   protected assertLive(): void {
      if (this.disposed) {
         throw new Error('DataSession is disposed');
      }
   }
}
