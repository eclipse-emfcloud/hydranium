/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A working copy over a real session and an in-memory server that gates every
 * write on the version it names, as a data server does, and pushes each
 * change to the session as an update event.
 */

import { compare } from 'fast-json-patch';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { DataConnection } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DataSession, type DataSessionHost } from '../../src/client/data-session';
import { type WorkingCopyEditOutcome, WorkingCopy } from '../../src/client/working-copy';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '../../src/data';
import { ConflictError, DocumentNotOpenError, SaveFailedError } from '../../src/errors';
import { asModelVersion } from '../../src/model-service/base-version';
import { ForceConflictResolver, type ReconcileOutcome, ReconcilingConflictResolver } from '../../src/patch-merge';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { makeFakeDataPort } from '../../src/testing/data-doubles';
import { type FakeClock, makeFakeClock } from '../../src/testing/fake-clock';
import { makeDuplexConnectionPair } from '../../src/testing/node';
import { tick, waitFor } from '../../src/testing/wait-for';
import type { TransferDiagnostic } from '../../src/transfer-diagnostic';
import { TransferDocument } from '../../src/transfer-document';
import type { TransferElement } from '../../src/transfer-element';
import type { Harness } from '../../src/testing/harness';
import { Deferred } from '../../src/util';

interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
   name: string;
   note: string;
}

const URI_A = 'file:///a.x';
const OTHER_CLIENT = 'other';

/** One document, as the server holds it. */
class ProbeServer {
   root: ProbeElement = { $type: 'TypeOne', name: 'initial', note: 'initial' };
   version = 1;
   /** The version last written to the file. */
   saved = 1;
   /** The clients that have the document open. */
   readonly opens = new Set<string>();
   /** Write requests received, refused ones included. */
   updates = 0;
   /** Sessions a client ended. */
   sessionsClosed = 0;
   /** Held by a test to keep opens from answering. */
   openGate?: Promise<void>;
   /** Held by a test to keep writes from answering. */
   updateGate?: Promise<void>;
   /** Held by a test to keep a write's answer back once its change has landed. */
   answerGate?: Promise<void>;
   /** A write answers the document as it is after {@link answerGate}, as a server answers its latest build. */
   answerLatest = false;
   /** Held by a test to keep reads from answering what they read. */
   readGate?: Promise<void>;
   /** Held by a test to keep reads from building their answer. */
   buildGate?: Promise<void>;
   /** Held by a test to keep a save from building its answer once it has saved. */
   saveGate?: Promise<void>;
   /** Reads received. */
   reads = 0;
   /** Refuses the next write before it lands. */
   failNext?: Error;
   /** Refuses the write with this number, counted from one, before it lands. */
   failAt?: number;
   /** The diagnostics a validated read carries. */
   problems: TransferDiagnostic[] = [];
   /** Reads answer that the document does not exist. */
   missing = false;
   protected sequence = 0;

   constructor(protected readonly connection: MessageConnection) {
      bindRpcMethods(
         connection,
         this,
         [
            'waitForReady',
            'createSession',
            'closeSession',
            'openModelDocument',
            'watchModelDocument',
            'getModelDocument',
            'closeModelDocument',
            'updateModelDocument',
            'persistModelDocument'
         ],
         { methodNamespace: DATA_SERVER_WIRE_PREFIX }
      );
   }

   async waitForReady(): Promise<void> {}

   async createSession(): Promise<void> {}

   async closeSession(): Promise<void> {
      this.sessionsClosed++;
   }

   async openModelDocument(args: { clientId: string }): Promise<unknown> {
      await this.openGate;
      this.opens.add(args.clientId);
      return this.document();
   }

   async watchModelDocument(): Promise<unknown> {
      return { uri: URI_A, exists: true, sequence: this.sequence, text: this.document().text };
   }

   async getModelDocument(args: { includeDiagnostics?: boolean }): Promise<unknown> {
      this.reads++;
      // Each gate holds the requests received after a test set it.
      const readGate = this.readGate;
      await this.buildGate;
      const answer = this.missing ? { uri: URI_A } : this.document(args.includeDiagnostics ?? false);
      await readGate;
      return answer;
   }

   async closeModelDocument(args: { clientId: string }): Promise<void> {
      this.opens.delete(args.clientId);
   }

   async updateModelDocument(args: { clientId: string; baseVersion: number | 'any'; model: ProbeElement }): Promise<unknown> {
      this.updates++;
      const answerGate = this.answerGate;
      await this.updateGate;
      const failure = this.failNext;
      if (failure) {
         this.failNext = undefined;
         throw failure;
      }
      if (this.updates === this.failAt) {
         throw new Error('refused');
      }
      if (!this.opens.has(args.clientId)) {
         throw new DocumentNotOpenError(URI_A, args.clientId);
      }
      if (args.baseVersion !== 'any' && args.baseVersion !== this.version) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.version);
      }
      await this.change(args.model, args.clientId);
      const answer = this.document();
      await answerGate;
      return this.answerLatest ? this.document() : answer;
   }

   async persistModelDocument(args: { clientId: string; baseVersion: number }): Promise<unknown> {
      const answerGate = this.answerGate;
      const saveGate = this.saveGate;
      if (!this.opens.has(args.clientId)) {
         throw new DocumentNotOpenError(URI_A, args.clientId);
      }
      if (args.baseVersion !== this.version) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.version);
      }
      await this.markSaved();
      await saveGate;
      const answer = { ...this.document(), persisted: { version: this.saved } };
      await answerGate;
      return answer;
   }

   /** Write `root` as another client, and push it. */
   foreignWrite(root: Partial<ProbeElement>): Promise<void> {
      return this.change({ ...this.root, ...root }, OTHER_CLIENT);
   }

   /** Save the text as another client, and push that it is clean. */
   foreignSave(): Promise<void> {
      return this.markSaved();
   }

   /**
    * Delete the document's file, which ends every open of it, and push that.
    * It reads as made again at once, unless a test sets {@link missing}.
    */
   deleteFile(): Promise<void> {
      this.opens.clear();
      return this.connection.sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentDeleted`, { uri: URI_A, sourceClientId: OTHER_CLIENT });
   }

   protected async change(root: ProbeElement, sourceClientId: string): Promise<void> {
      // As the server does, a write that changes no text makes no version.
      if (compare(this.root, root).length === 0) {
         return;
      }
      const wasDirty = this.version !== this.saved;
      this.root = root;
      this.version++;
      // As the server does, every watcher hears a flip, the writer included.
      if (!wasDirty) {
         await this.sendDirty();
      }
      await this.push(this.document(), sourceClientId);
   }

   /** Push `document` as written by `sourceClientId`. */
   push(document: TransferDocument<ProbeElement>, sourceClientId: string): Promise<void> {
      return this.connection.sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentUpdated`, {
         document,
         sourceClientId,
         reason: 'changed',
         sequence: ++this.sequence
      });
   }

   protected async markSaved(): Promise<void> {
      const wasDirty = this.version !== this.saved;
      this.saved = this.version;
      if (wasDirty) {
         await this.sendDirty();
      }
   }

   protected sendDirty(): Promise<void> {
      return this.connection.sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentDirtyChanged`, {
         uri: URI_A,
         text: this.document().text
      });
   }

   /** The document as it is now, with diagnostics unless a read did not ask for them. */
   protected document(withDiagnostics = true): TransferDocument<ProbeElement> {
      return {
         uri: URI_A,
         model: {
            root: this.root,
            ...(withDiagnostics ? { diagnostics: this.problems } : {}),
            version: asModelVersion(this.version),
            // As the server's, an equal hash means equally validated.
            hash: JSON.stringify([this.root, withDiagnostics ? this.problems : undefined])
         },
         text: { version: this.version, hash: JSON.stringify(this.root), dirty: this.version !== this.saved }
      };
   }
}

/** The copies a test made, disposed after it. */
const copies: WorkingCopy<ProbeElement>[] = [];

/** A copy on a fake clock, so a test runs out the settle wait itself. */
class HeldCopy extends WorkingCopy<ProbeElement> {
   override readonly clock: FakeClock = makeFakeClock();
   protected override readonly settleWritesMs = 1_000;

   constructor(...args: ConstructorParameters<typeof WorkingCopy<ProbeElement>>) {
      super(...args);
      copies.push(this);
   }
}

/** A copy whose next request settle throws once, as a defect past a write would. */
class FailingSettleCopy extends HeldCopy {
   failNext = false;

   protected override settleRequest(...args: Parameters<HeldCopy['settleRequest']>): void {
      if (this.failNext) {
         this.failNext = false;
         throw new Error('settle failed');
      }
      super.settleRequest(...args);
   }
}

/** A copy that gives up after the first conflicting write. */
class OneWriteCopy extends HeldCopy {
   protected override readonly maxWrites = 1;
}

/**
 * A resolver that, from its call numbered `heldFrom` on, waits after its
 * refetch until a test lets it merge. The first call reconciles a whole batch,
 * the ones after replay the edits of a split one.
 */
class HeldResolver extends ReconcilingConflictResolver {
   readonly held = new Deferred<void>();
   readonly merge = new Deferred<void>();
   protected calls = 0;

   constructor(protected readonly heldFrom: number) {
      super();
   }

   override resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
      if (++this.calls < this.heldFrom) {
         return super.resolve(base, ours, refetch);
      }
      return super.resolve(base, ours, async () => {
         const theirs = await refetch();
         this.held.resolve();
         await this.merge.promise;
         return theirs;
      });
   }
}

/** A copy that writes its edits over a conflict without a reread. */
class ForceCopy extends HeldCopy {
   protected override readonly conflictResolver = new ForceConflictResolver();
}

/** A copy whose resolver is a {@link HeldResolver}. */
class HeldResolverCopy extends HeldCopy {
   readonly resolver: HeldResolver;
   protected override readonly conflictResolver: HeldResolver;

   constructor(session: DataSession<ProbeElement>, events: DataEvents<ProbeElement>, heldFrom: number) {
      super(session, events, URI_A);
      this.resolver = this.conflictResolver = new HeldResolver(heldFrom);
   }
}

const PROBLEM: TransferDiagnostic = { type: 'validation-error', element: '', message: 'probe', severity: 'error' };

interface CopyHarness extends Harness {
   /** The server of the first connection. A restart answers with another. */
   readonly server: ProbeServer;
   readonly session: DataSession<ProbeElement>;
   readonly events: DataEvents<ProbeElement>;
   /**
    * Drop the connection and serve the next one from a restarted server that
    * holds the text the last one held, with `root` laid over it, saved and
    * numbered from version 1 again.
    */
   restart(root?: Partial<ProbeElement>): ProbeServer;
}

const harnesses: CopyHarness[] = [];

/** A session that waits `settleBeforeCloseMs` for its calls before a close. */
class ClosingSession extends DataSession<ProbeElement> {
   constructor(
      clientId: string,
      host: DataSessionHost<ProbeElement, DataServerProtocol<ProbeElement>>,
      label: string,
      protected override readonly settleBeforeCloseMs: number
   ) {
      super(clientId, host, label);
   }
}

/** `settleBeforeCloseMs`, when given, bounds the session's wait before a close. */
function makeCopyHarness(settleBeforeCloseMs?: number): CopyHarness {
   let pair = makeDuplexConnectionPair();
   const pairs = [pair];
   let server = new ProbeServer(pair.left);
   let next: MessageConnection | undefined = pair.right;
   const events = new DataEvents<ProbeElement>();
   const port = makeFakeDataPort({
      connect: () => {
         const connection = next;
         next = undefined;
         if (!connection) {
            throw new Error('No server to connect to');
         }
         return connection;
      }
   });
   const connection = new DataConnection<ProbeElement>(
      port,
      events,
      settleBeforeCloseMs === undefined
         ? {}
         : { sessionFactory: (clientId, host, label) => new ClosingSession(clientId, host, label, settleBeforeCloseMs) }
   );
   let disposed = false;
   const harness: CopyHarness = {
      server,
      session: connection.createSession('form', 'form'),
      events,
      restart: root => {
         const restarted = makeDuplexConnectionPair();
         pairs.push(restarted);
         const held = server.root;
         server = new ProbeServer(restarted.left);
         server.root = { ...held, ...root };
         next = restarted.right;
         port.fireDispose();
         // Ends only, as a reply still being written would fail on a destroyed stream.
         pair.left.dispose();
         pair.right.dispose();
         pair = restarted;
         return server;
      },
      dispose: () => {
         if (disposed) {
            return;
         }
         disposed = true;
         connection.dispose();
         pairs.forEach(each => each.dispose());
      }
   };
   harnesses.push(harness);
   return harness;
}

/** Resolves once the session has heard the next update of the document. */
function nextUpdate(events: DataEvents<ProbeElement>): Promise<void> {
   const heard = new Deferred<void>();
   const listener = events.onDidUpdateDocument(() => {
      listener.dispose();
      heard.resolve();
   });
   return heard.promise;
}

describe('WorkingCopy', () => {
   afterEach(() => {
      copies.splice(0).forEach(copy => copy.dispose());
      harnesses.splice(0).forEach(harness => harness.dispose());
   });

   it('reports a conflict for an edit whose field another client changed while it waited to be written', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      const outcome = copy.edit(root => ({ ...root, name: 'ours' }));
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');

      expect(await outcome).toEqual({ status: 'conflict' });
      expect(server.root.name).toBe('theirs');
      expect(copy.root?.name).toBe('theirs');
   });

   it('closes a document whose open was still under way when it was closed', async () => {
      const { server, session, events } = makeCopyHarness();
      const opened = new Deferred<void>();
      server.openGate = opened.promise;
      const copy = new HeldCopy(session, events, URI_A);

      const opening = copy.open();
      const closing = copy.close();
      opened.resolve();
      await opening;
      await closing;

      expect(server.opens.size).toBe(0);
      expect(copy.snapshot).toBeUndefined();
   });

   it('saves the text the server holds dirty while the second read of its open is out', async () => {
      const { server, session, events } = makeCopyHarness();
      await server.foreignWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const copy = new HeldCopy(session, events, URI_A);
      const opening = copy.open();
      await waitFor(() => server.reads === 1);

      const dirty = copy.dirty;
      const saved = copy.save();
      read.resolve();
      await opening;
      await saved;

      expect({ dirty, saved: server.saved }).toEqual({ dirty: true, saved: server.version });
   });

   it('closes once the bound passes while its open is not answered, and closes that open when it answers', async () => {
      const { server, session, events } = makeCopyHarness(10);
      const opened = new Deferred<void>();
      server.openGate = opened.promise;
      const copy = new HeldCopy(session, events, URI_A);
      const opening = copy.open();
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      await closing;

      opened.resolve();
      await expect(opening).rejects.toThrow();
      await waitFor(() => server.opens.size === 0);
      expect(copy.snapshot).toBeUndefined();
   });

   it('closes once the bound passes while the second read of its open is not answered, and follows nothing after', async () => {
      const { server, session, events } = makeCopyHarness(10);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const copy = new HeldCopy(session, events, URI_A);
      const opening = copy.open();
      await waitFor(() => server.reads === 1);
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      await closing;

      read.resolve();
      await expect(opening).rejects.toThrow();
      expect({ opens: server.opens.size, snapshot: copy.snapshot }).toEqual({ opens: 0, snapshot: undefined });
   });

   it('shows a write of the copy before it that lands after its open', async () => {
      const { server, session, events } = makeCopyHarness(10);
      const first = new HeldCopy(session, events, URI_A);
      await first.open();
      const landed = new Deferred<void>();
      server.updateGate = landed.promise;
      void first.edit(root => ({ ...root, note: 'late' })).catch(() => undefined);
      await waitFor(() => server.updates === 1);
      const closed = first.close();
      await waitFor(() => first.clock.pendingTimers() > 0);
      first.clock.advance(1_000);
      await closed;
      const second = new HeldCopy(session, events, URI_A);
      await second.open();

      landed.resolve();
      await waitFor(() => server.root.note === 'late');

      await waitFor(() => second.root?.note === 'late', { message: 'the second copy never showed the late write' });
   });

   it('follows the document in a copy opened once the copy before it has closed', async () => {
      const { server, session, events } = makeCopyHarness();
      const first = new HeldCopy(session, events, URI_A);
      await first.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = first.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);

      const closed = first.close();
      const second = new HeldCopy(session, events, URI_A);
      const opened = closed.then(() => second.open());
      answered.resolve();
      await opened;
      await server.foreignWrite({ note: 'theirs' });

      expect(await written).toEqual({ status: 'applied' });
      await waitFor(() => second.root?.note === 'theirs');
      expect(server.opens.has(session.clientId)).toBe(true);
   });

   it('stays closed when a write it gave up waiting for answers after the close', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'late' }));
      await waitFor(() => server.updates === 1);

      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      answered.resolve();
      await closing;

      expect(await written).toEqual({ status: 'applied' });
      expect(copy.snapshot).toBeUndefined();
   });

   it('writes an edit made during a write on that write, without a conflict of its own', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);

      const second = copy.edit(root => ({ ...root, note: 'second' }));
      answered.resolve();

      expect(await first).toEqual({ status: 'applied' });
      expect(await second).toEqual({ status: 'applied' });
      expect(server.updates).toBe(2);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'first', note: 'second' });
   });

   it('keeps an edit made during a write that merged with a foreign edit', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'ab' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ note: 'theirs' });

      const second = copy.edit(root => ({ ...root, name: 'abc' }));
      answered.resolve();

      expect(await first).toEqual({ status: 'merged' });
      expect(await second).toEqual({ status: 'merged' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'abc', note: 'theirs' });
      expect(copy.root).toEqual(server.root);
   });

   it("shows the server's value in its last change once a same-field conflict dropped the edit", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const shown: string[] = [];
      copy.onDidChange(() => shown.push(copy.root?.name ?? ''));

      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      answered.resolve();

      expect(await written).toEqual({ status: 'conflict' });
      expect(shown.at(-1)).toBe('theirs');
   });

   it('shows an edit that is not idempotent once in every change, its answer included', async () => {
      const { session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(() => shown.push(copy.root?.note ?? ''));

      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));

      expect(await written).toEqual({ status: 'applied' });
      expect(shown).toEqual(['initial!', 'initial!']);
   });

   it('writes an edit made during a write that failed without the failed edit', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'refused' }));
      await waitFor(() => server.updates === 1);

      const second = copy.edit(root => ({ ...root, note: 'second' }));
      server.failNext = new Error('refused');
      answered.resolve();

      await expect(first).rejects.toThrow('refused');
      expect(await second).toEqual({ status: 'applied' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'initial', note: 'second' });
   });

   it("keeps another client's value under an edit made during a write that conflicted", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });

      const second = copy.edit(root => ({ ...root, note: 'later' }));
      server.updateGate = undefined;
      answered.resolve();

      expect(await first).toEqual({ status: 'conflict' });
      expect(await second).toEqual({ status: 'merged' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'later' });
      expect(copy.root).toEqual(server.root);
   });

   it("keeps another client's value under edits each sent at once while the one before conflicts", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, note: 'n' }));
      await waitFor(() => server.updates === 1 && server.version === 2);
      server.answerGate = undefined;
      await server.foreignWrite({ name: 'theirs' });
      const second = copy.edit(root => ({ ...root, name: 'ours' }));
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      answer.resolve();
      await waitFor(() => server.updates === 2);

      const third = copy.edit(root => ({ ...root, note: 'n2' }));
      server.updateGate = undefined;
      answered.resolve();

      expect([await first, await second, await third]).toEqual([{ status: 'applied' }, { status: 'conflict' }, { status: 'merged' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'n2' });
   });

   it('writes no edit dropped when its write ran out of writes under an edit made meanwhile', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new OneWriteCopy(session, events, URI_A);
      await copy.open();
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.snapshot?.model?.root.note === 'theirs');
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      await waitFor(() => server.updates === 1);

      const second = copy.edit(root => ({ ...root, note: 'later' }));
      server.updateGate = undefined;
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'conflict' }, { status: 'applied' }]);
      expect(server.root.name).toBe('initial');
   });

   it("reports a conflict for an edit of a dropped field made during the split write, keeping another client's value", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });

      const retyped = copy.edit(root => ({ ...root, name: 'retyped' }));
      server.updateGate = undefined;
      answered.resolve();

      expect([await name, await note, await retyped]).toEqual([{ status: 'conflict' }, { status: 'merged' }, { status: 'conflict' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'unrelated' });
      expect(copy.root).toEqual(server.root);
   });

   it("keeps another client's update that arrived before the answer to its own earlier write", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;

      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(copy.version).toBe(3);
      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'ours', note: 'theirs' });
   });

   it("keeps another client's change to a field the user edits while the answer to their write already holds it", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;
      const second = copy.edit(root => ({ ...root, note: 'ours' }));

      answered.resolve();
      expect(await first).toEqual({ status: 'applied' });

      expect(await second).toEqual({ status: 'conflict' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'ours', note: 'theirs' });
   });

   it("merges an edit of another field queued while the answer to the write before already holds another client's change", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;
      const second = copy.edit(root => ({ ...root, name: 'again' }));

      answered.resolve();
      expect(await first).toEqual({ status: 'applied' });

      expect(await second).toEqual({ status: 'merged' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'again', note: 'theirs' });
   });

   it('writes an edit at once, and the edits made in the same turn as one write', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'ours' }));

      expect([await name, await note]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(server.updates).toBe(1);
      expect(server.root).toMatchObject({ name: 'ours', note: 'ours' });
   });

   it("reports a conflict for an edit of a dropped field made during the split write of a batch queued behind a write, keeping another client's value", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: 'first' }));
      await waitFor(() => server.version === 2);
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await server.foreignWrite({ name: 'theirs' });
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      server.answerGate = undefined;
      answered.resolve();
      expect(await first).toEqual({ status: 'applied' });
      await waitFor(() => server.updates === 2);

      const retyped = copy.edit(root => ({ ...root, name: 'retyped' }));
      server.updateGate = undefined;
      held.resolve();

      expect([await name, await note, await retyped]).toEqual([{ status: 'conflict' }, { status: 'merged' }, { status: 'conflict' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'unrelated' });
   });

   it('keeps the answer to its write over a push of an older version that arrives after it', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const stale = TransferDocument.assertLoaded(
         (await (await session.connected()).getModelDocument({ uri: URI_A })) as TransferDocument<ProbeElement>
      );
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      expect(await written).toEqual({ status: 'applied' });

      const heard = nextUpdate(events);
      await server.push(stale, OTHER_CLIENT);
      await heard;

      expect(copy.version).toBe(2);
      expect(copy.root?.name).toBe('ours');
   });

   it('announces its dirty state when an edit makes it unsaved and when a save elsewhere makes it clean', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const announced: boolean[] = [];
      copy.onDidChangeDirty(() => announced.push(copy.dirty));
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await written;

      await server.foreignSave();
      await waitFor(() => !copy.dirty);

      expect(announced).toEqual([true, false]);
   });

   it('writes an edit made just before it is disposed and announces nothing after', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      let changes = 0;
      copy.onDidChange(() => changes++);

      copy.dispose();

      expect(await written).toEqual({ status: 'applied' });
      expect(server.root.name).toBe('ours');
      expect(changes).toBe(0);
   });

   it('keeps a change made while its server was down under an edit queued before it was disposed', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'one' }));

      const restarted = harness.restart({ note: 'external' });
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await tick(0);
      const queued = copy.edit(root => ({ ...root, name: 'queued' }));
      copy.dispose();
      await written;
      await queued;

      expect(restarted.root).toMatchObject({ name: 'queued', note: 'external' });
   });

   it('does not write an edit queued before it was disposed once its file was deleted', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const sent = copy.edit(root => ({ ...root, note: 'sent' }));
      await waitFor(() => server.root.note === 'sent');
      const queued = copy.edit(root => ({ ...root, name: 'queued' }));
      copy.dispose();

      await server.deleteFile();
      server.answerGate = undefined;
      answered.resolve();
      await sent;

      expect(await queued).toEqual({ status: 'unavailable' });
      expect(server.root.name).toBe('initial');
   });

   it('keeps its snapshot over a push of an older version that arrives during a write that fails', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const stale = TransferDocument.assertLoaded(
         (await (await session.connected()).getModelDocument({ uri: URI_A })) as TransferDocument<ProbeElement>
      );
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.version === 2);
      const gate = new Deferred<void>();
      server.updateGate = gate.promise;
      server.failNext = new Error('refused');
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      const heard = nextUpdate(events);
      await server.push(stale, OTHER_CLIENT);
      await heard;

      gate.resolve();

      await expect(written).rejects.toThrow('refused');
      expect(copy.version).toBe(2);
      expect(copy.root?.note).toBe('theirs');
   });

   it('saves after an edit made while the save waited for the write before', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const gate = new Deferred<void>();
      server.updateGate = gate.promise;
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      const saved = copy.save();
      const second = copy.edit(root => ({ ...root, note: 'ours' }));
      server.updateGate = undefined;

      gate.resolve();

      expect(await first).toEqual({ status: 'applied' });
      expect(await second).toEqual({ status: 'applied' });
      await saved;
      expect(server.saved).toBe(server.version);
      expect(server.root).toMatchObject({ name: 'ours', note: 'ours' });
   });

   it("keeps another client's update that arrived before the answer to its save", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await server.foreignWrite({ name: 'unsaved' });
      await waitFor(() => copy.version === 2);
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const saving = copy.save();
      await waitFor(() => server.saved === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;

      answered.resolve();
      await saving;

      expect(copy.version).toBe(3);
      expect(copy.root?.note).toBe('theirs');
   });

   it("keeps another client's update that arrived before its open's second read answered", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const opened = copy.open();
      await waitFor(() => server.reads === 1);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;

      read.resolve();
      await opened;

      expect(copy.version).toBe(2);
      expect(copy.root?.note).toBe('theirs');
   });

   it.each([
      ['a same-field conflict', HeldCopy],
      ['running out of writes', OneWriteCopy]
   ])("shows the server's diagnostics once %s dropped the edit", async (_case, Copy) => {
      const { server, session, events } = makeCopyHarness();
      const copy = new Copy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      // Only the read after the conflict carries them.
      server.problems = [PROBLEM];
      answered.resolve();

      expect(await written).toEqual({ status: 'conflict' });
      expect(copy.diagnostics).toEqual([PROBLEM]);
   });

   it('stays without a document when a write answers after its file was deleted', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'late' }));
      await waitFor(() => server.version === 2);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);

      answered.resolve();
      await written;

      expect(copy.snapshot).toBeUndefined();
   });

   it('fails its open and stays without a document when its second read answers after its file was deleted', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const opened = copy.open();
      await waitFor(() => server.reads === 1);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);

      read.resolve();

      await expect(opened).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(copy.snapshot).toBeUndefined();
   });

   it('keeps the document opened again when the open before it fails its second read after the file was deleted', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const first = copy.open();
      await waitFor(() => server.reads === 1);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      server.readGate = undefined;
      await copy.open();

      read.reject(new Error('read failed'));
      await expect(first).rejects.toThrow('read failed');
      await copy.open();

      expect(server.reads).toBe(2);
      expect(server.opens.has(session.clientId)).toBe(true);
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.root?.note === 'theirs');
   });

   it('keeps the document opened again when the open before it finds the file gone after the deletion', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      server.missing = true;
      const first = copy.open();
      await waitFor(() => server.reads === 1);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      server.readGate = undefined;
      server.missing = false;
      await copy.open();

      read.resolve();
      await expect(first).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(copy.snapshot).toBeDefined();
      expect(server.opens.has(session.clientId)).toBe(true);
   });

   it('conflicts on an edit of the document opened again when a write from before the deletion fails', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const refused = new Deferred<void>();
      server.updateGate = refused.promise;
      const stale = copy.edit(root => ({ ...root, name: 'stale' }));
      await waitFor(() => server.updates === 1);
      server.updateGate = undefined;
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();
      const ours = copy.edit(root => ({ ...root, name: 'ours' }));
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');

      refused.reject(new Error('refused'));
      await expect(stale).rejects.toThrow('refused');

      expect(await ours).toEqual({ status: 'conflict' });
      expect(server.root.name).toBe('theirs');
   });

   it("closes the session's open under its own spelling of a URI the server spells otherwise", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, 'file:///./a.x');
      await copy.open();
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      expect(await written).toEqual({ status: 'applied' });
      expect(session['unsavedWrites'].has('file:///./a.x')).toBe(true);
      await copy.save();
      expect(session['unsavedWrites'].size).toBe(0);

      await copy.close();

      expect(session['opens'].size).toBe(0);
      expect(server.opens.size).toBe(0);
   });

   it('opens again once its file was deleted', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);

      await copy.open();

      expect(copy.root?.name).toBe('initial');
   });

   it("keeps another client's edit of the same field that landed between its write and that write's answer", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;

      expect(copy.root?.name).toBe('ours');
      const second = copy.edit(root => ({ ...root, note: 'second' }));
      answered.resolve();

      expect(await first).toEqual({ status: 'applied' });
      expect(await second).toEqual({ status: 'merged' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'second' });
      expect(copy.root).toEqual(server.root);
   });

   it("shows an edit that is not idempotent once while another client's update waits behind its answer", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;

      expect(copy.root?.note).toBe('initial!');
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'initial!' });
      expect(copy.root).toEqual(server.root);
   });

   it("drops the document when its open's second read failed, and opens it again", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const failed = Promise.reject(new Error('read failed'));
      failed.catch(() => undefined);
      server.readGate = failed;

      await expect(copy.open()).rejects.toThrow('read failed');
      expect(copy.snapshot).toBeUndefined();
      await waitFor(() => server.opens.size === 0);

      server.readGate = undefined;
      await copy.open();
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.root?.note === 'theirs');
   });

   it('does not write an edit queued before its file was deleted onto the document opened again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const sent = copy.edit(root => ({ ...root, note: 'sent' }));
      await waitFor(() => server.root.note === 'sent');
      const before = copy.edit(root => ({ ...root, name: 'before' }));
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      server.answerGate = undefined;
      answered.resolve();
      await sent;

      await copy.open();
      const after = copy.edit(root => ({ ...root, note: 'after' }));

      expect(await before).toEqual({ status: 'unavailable' });
      expect(await after).toEqual({ status: 'applied' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'initial', note: 'after' });
   });

   it('writes nothing for a batch that changes nothing', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      const written = copy.edit(root => ({ ...root }));

      expect(await written).toEqual({ status: 'unchanged' });
      expect(server.updates).toBe(0);
      expect(copy.dirty).toBe(false);
   });

   it('saves nothing when the server holds no unsaved text', async () => {
      const { session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      expect(await copy.save()).toBeUndefined();
   });

   it('refuses an edit and a save once disposed, and writes nothing', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'mine' }));

      copy.dispose();

      await expect(copy.edit(root => ({ ...root, name: 'late' }))).rejects.toThrow('WorkingCopy is disposed');
      await expect(copy.save()).rejects.toThrow('WorkingCopy is disposed');
      expect(server.updates).toBe(1);
      expect(server.saved).not.toBe(server.version);
   });

   it('shares one open between calls made while it is under way', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const opening = new Deferred<void>();
      server.openGate = opening.promise;
      const opened = [copy.open(), copy.open()];

      opening.resolve();
      await Promise.all(opened);

      expect(server.reads).toBe(1);
      expect(copy.snapshot).toBeDefined();
   });

   it('refuses to save while a write has not answered within its bound', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));

      const saving = copy.save();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);

      await expect(saving).rejects.toBeInstanceOf(SaveFailedError);
      answered.resolve();
      expect(await written).toEqual({ status: 'applied' });
   });

   it('refuses to save once its bound has passed over the writes of edits made while it waited', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const first = new Deferred<void>();
      server.updateGate = first.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.updates === 1);
      const saving = copy.save();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(600);
      const during = copy.edit(root => ({ ...root, note: 'during' }));
      const second = new Deferred<void>();
      server.updateGate = second.promise;
      first.resolve();
      await waitFor(() => server.updates === 2);

      copy.clock.advance(600);

      await expect(saving).rejects.toBeInstanceOf(SaveFailedError);
      second.resolve();
      expect([await written, await during]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
   });

   it('settles its writes once an edit made while it waited has answered too', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const first = new Deferred<void>();
      server.updateGate = first.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.updates === 1);
      const settled = copy.whenWritesSettled().then(result => ({ result, inFlight: copy.hasWritesInFlight }));
      const during = copy.edit(root => ({ ...root, note: 'during' }));
      const second = new Deferred<void>();
      server.updateGate = second.promise;

      first.resolve();
      await waitFor(() => server.updates === 2);
      second.resolve();

      expect(await settled).toEqual({ result: true, inFlight: false });
      expect([await written, await during]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
   });

   it('stops waiting for its writes once its bound has passed', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));

      const settled = copy.whenWritesSettled();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);

      expect(await settled).toBe(false);
      answered.resolve();
      expect(await written).toEqual({ status: 'applied' });
   });

   it("stops holding another client's update once a request answered with another still out", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'mine' }));
      const saved = new Deferred<void>();
      server.saveGate = saved.promise;
      const first = copy.save();
      await waitFor(() => server.saved === server.version);
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.clock.pendingTimers() > 0);

      // Gated on the version before the update, so it answers at once.
      await expect(copy.save()).rejects.toBeInstanceOf(ConflictError);

      expect({ note: copy.root?.note, timers: copy.clock.pendingTimers() }).toEqual({ note: 'theirs', timers: 0 });
      saved.resolve();
      await first;
   });

   it("holds another client's update while its write is unanswered, and shows it once the write fails", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const refused = new Deferred<void>();
      server.updateGate = refused.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;

      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'ours', note: 'initial' });
      refused.reject(new Error('refused'));

      await expect(written).rejects.toThrow('refused');
      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'initial', note: 'theirs' });
   });

   it("shows another client's update once its write has not answered within its bound", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      server.updateGate = new Deferred<void>().promise;
      void copy.edit(root => ({ ...root, name: 'ours' })).catch(() => undefined);
      await waitFor(() => server.updates === 1);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;
      expect(copy.root?.note).toBe('initial');

      copy.clock.advance(1_000);

      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'ours', note: 'theirs' });
   });

   it("stops the timer of another client's held update once disposed", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      server.updateGate = new Deferred<void>().promise;
      void copy.edit(root => ({ ...root, name: 'ours' })).catch(() => undefined);
      await waitFor(() => server.updates === 1);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;
      expect(copy.clock.pendingTimers()).toBeGreaterThan(0);

      copy.dispose();

      expect(copy.clock.pendingTimers()).toBe(0);
   });

   it('takes an edit made while an edit out throws on the root shown', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      const first = copy.edit(root => {
         if (root.name === 'theirs') {
            throw new TypeError('renamed');
         }
         return { ...root, note: 'first' };
      });
      await waitFor(() => server.root.note === 'first');
      server.answerGate = undefined;
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');
      expect(() => copy.root).toThrow('renamed');

      const second = copy.edit(root => ({ ...root, note: 'second' }));
      answer.resolve();

      expect(await first).toEqual({ status: 'applied' });
      expect((await second).status).toBe('merged');
      expect(server.root).toMatchObject({ name: 'theirs', note: 'second' });
   });

   it("keeps another client's edit of a field over an edit queued behind a write the server normalized to no change", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      // Trims the name, and makes no version when nothing changed.
      const change = server['change'].bind(server);
      server['change'] = async (root, clientId) => {
         const normalized = { ...root, name: root.name.trim() };
         if (JSON.stringify(normalized) !== JSON.stringify(server.root)) {
            await change(normalized, clientId);
         }
      };
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, name: 'initial ' }));
      await waitFor(() => server.updates === 1);
      const second = copy.edit(root => ({ ...root, name: 'ours' }));
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      server.answerGate = undefined;
      answer.resolve();
      await first;

      expect({ outcome: await second, server: server.root.name }).toEqual({ outcome: { status: 'conflict' }, server: 'theirs' });
   });

   it('announces the dirty flag of a write answer once the answer is shown, so an edit made then is applied', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const gate = new Deferred<void>();
      server.answerGate = gate.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);
      let second: Promise<WorkingCopyEditOutcome> | undefined;
      let seen: string | undefined;
      copy.onDidChangeDirty(() => {
         if (!copy.dirty && !second) {
            seen = copy.root?.name;
            second = copy.edit(root => ({ ...root, name: 'second' }));
         }
      });
      // Saved before the answer is built, so the answer reads clean.
      await server.foreignWrite({ note: 'theirs' });
      server.saved = server.version;
      server.answerGate = undefined;
      gate.resolve();
      await first;
      await waitFor(() => second !== undefined);
      expect({ second: await second, seen, server: server.root.name }).toEqual({
         second: { status: 'applied' },
         seen: 'first',
         server: 'second'
      });
   });

   it('rejects the batch whose write fails past its write, and writes the edit queued behind it', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new FailingSettleCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);
      const queued = copy.edit(root => ({ ...root, note: 'queued' }));
      copy.failNext = true;

      held.resolve();

      await expect(first).rejects.toThrow('settle failed');
      expect((await queued).status).not.toBe('unavailable');
      expect(server.root).toMatchObject({ name: 'first', note: 'queued' });
      expect(copy.hasWritesInFlight).toBe(false);
   });

   it('writes an edit that is not idempotent once when an update that held it was shown before its write answered', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.root.note === 'initial!');
      server.answerGate = undefined;
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');

      const second = copy.edit(root => ({ ...root, name: 'mine' }));
      answer.resolve();

      expect(await first).toEqual({ status: 'applied' });
      await second;
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'mine', note: 'initial!' });
   });

   it("shows an edit that is not idempotent once when its open's second read answers with it while its write is out", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.buildGate = read.promise;
      const opened = copy.open();
      await waitFor(() => server.reads === 1);
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);

      read.resolve();
      await opened;
      expect(copy.root?.note).toBe('initial!');
      const second = copy.edit(root => ({ ...root, name: 'second' }));
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'second', note: 'initial!' });
   });

   it('shows an edit that is not idempotent once when a save answers with it while its write is out', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await server.foreignWrite({ name: 'unsaved' });
      await waitFor(() => copy.version === 2);
      const built = new Deferred<void>();
      server.saveGate = built.promise;
      const saving = copy.save();
      await waitFor(() => server.saved === 2);
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 3);

      built.resolve();
      await saving;
      expect(copy.root?.note).toBe('initial!');
      const second = copy.edit(root => ({ ...root, name: 'second' }));
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'second', note: 'initial!' });
   });

   it('stays clean once another client saved its write while that write was unanswered', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const saved = new Deferred<void>();
      const listener = events.onDidChangeDocumentDirty(() => saved.resolve());
      await server.foreignSave();
      await saved.promise;
      listener.dispose();

      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(copy.dirty).toBe(false);
   });

   it('stays clean once another client saved while its write was out', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ note: 'theirs' });
      await heard;
      const saved = new Deferred<void>();
      const listener = events.onDidChangeDocumentDirty(() => saved.resolve());
      await server.foreignSave();
      await saved.promise;
      listener.dispose();

      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(copy.dirty).toBe(false);
   });

   it('writes the edits of a batch that do not collide when another edit of it conflicts', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');

      expect([await name, await note]).toEqual([{ status: 'conflict' }, { status: 'merged' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'unrelated' });
      expect(copy.root).toEqual(server.root);
   });

   it('writes nothing to the document opened again of the edits of a split batch replayed across the deletion', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldResolverCopy(session, events, 2);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      server.updateGate = undefined;
      answered.resolve();
      await copy.resolver.held.promise;
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();

      copy.resolver.merge.resolve();

      expect([await name, await note]).toEqual([{ status: 'conflict' }, { status: 'unavailable' }]);
      expect(server.updates).toBe(1);
      expect(server.root.note).toBe('initial');
   });

   it('still reports the conflict of an edit when the write of the other edits of its batch fails', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      server.failAt = 2;
      server.updateGate = undefined;
      answered.resolve();

      expect(await name).toEqual({ status: 'conflict' });
      await expect(note).rejects.toThrow('refused');
   });

   it('writes nothing more when every edit of a batch conflicts', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'ours' }));
      await server.foreignWrite({ name: 'theirs', note: 'theirs' });
      await waitFor(() => copy.version === 2);

      expect([await name, await note]).toEqual([{ status: 'conflict' }, { status: 'conflict' }]);
      expect(server.updates).toBe(1);
      expect(copy.root).toEqual(server.root);
   });

   it('ignores a write that answers after its file was deleted and the document opened again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'late' }));
      await waitFor(() => server.version === 2);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.version === 3);

      answered.resolve();
      await written;

      expect(copy.version).toBe(3);
      expect(copy.root?.note).toBe('theirs');
   });

   it('reports a conflict when it ran out of writes and could not read the document again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new OneWriteCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      const failed = Promise.reject(new Error('read failed'));
      failed.catch(() => undefined);
      server.buildGate = failed;

      answered.resolve();

      expect(await written).toEqual({ status: 'conflict' });
   });

   it('writes an edit made while its close waits once the write out answers in time', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.updates === 1);
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      const during = copy.edit(root => ({ ...root, note: 'during' }));

      answered.resolve();
      await closing;

      expect([await written, await during]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(server.root.note).toBe('during');
   });

   it('merges an edit made while its close waits that meets a write of another client', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.root.name === 'slow');
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      const during = copy.edit(root => ({ ...root, note: 'during' }));
      await server.foreignWrite({ name: 'theirs' });

      server.answerGate = undefined;
      answered.resolve();
      await closing;

      expect([await written, await during]).toEqual([{ status: 'applied' }, { status: 'merged' }]);
      expect(server.root.note).toBe('during');
   });

   it('settles an edit made while its close waited as unavailable, and is clean once closed', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.updates === 1);
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      const during = copy.edit(root => ({ ...root, note: 'during' }));

      copy.clock.advance(1_000);
      expect(await during).toEqual({ status: 'unavailable' });
      expect(copy.dirty).toBe(false);
      answered.resolve();
      await closing;

      expect(await written).toEqual({ status: 'applied' });
      expect(server.root.note).toBe('initial');
   });

   it('rejects an edit whose change throws, and writes the edits queued beside it', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);
      const second = copy.edit(root => ({ ...root, note: 'second' }));

      await expect(
         copy.edit(() => {
            throw new Error('bad edit');
         })
      ).rejects.toThrow('bad edit');
      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'first', note: 'second' });
      answered.resolve();

      expect(await first).toEqual({ status: 'applied' });
      expect(await second).toEqual({ status: 'applied' });
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'first', note: 'second' });
   });

   it('keeps the open a listener of the drop calls when a read after a conflict finds the file gone', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      server.missing = true;
      let reopened: Promise<void> | undefined;
      copy.onDidChange(() => {
         if (!copy.snapshot && !reopened) {
            server.missing = false;
            reopened = copy.open();
         }
      });

      answered.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      await waitFor(() => reopened !== undefined);
      await reopened;
      expect(copy.root?.name).toBe('theirs');
      // A close left over from the dropped open would end it after a turn.
      await tick();
      expect(server.opens.has(session.clientId)).toBe(true);
   });

   it('reports an edit as unavailable when its document is gone by the read after a conflict', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      server.missing = true;

      answered.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      expect(server.updates).toBe(1);
      expect(copy.snapshot).toBeUndefined();
      await waitFor(() => server.opens.size === 0);
      server.missing = false;
      await copy.open();
      expect(copy.root?.name).toBe('theirs');
      expect(server.opens.has(session.clientId)).toBe(true);
   });

   it('writes nothing to the document opened again of an edit whose read after a conflict answers after the deletion', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      const reread = new Deferred<void>();
      server.readGate = reread.promise;
      const reads = server.reads;
      answered.resolve();
      await waitFor(() => server.reads === reads + 1);
      server.readGate = undefined;
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();

      reread.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      expect(server.updates).toBe(1);
      expect(server.root.note).toBe('initial');
   });

   it('writes nothing to the document opened again of an edit its resolver merges after the deletion', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldResolverCopy(session, events, 1);
      await copy.open();
      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await server.foreignWrite({ name: 'theirs' });
      await copy.resolver.held.promise;
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();

      copy.resolver.merge.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      expect(server.updates).toBe(1);
      expect(server.root.note).toBe('initial');
   });

   it('writes nothing to the document opened again of an edit its resolver forces after the deletion', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new ForceCopy(session, events, URI_A);
      await copy.open();
      const gate = new Deferred<void>();
      server.updateGate = gate.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ note: 'theirs' });
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      // Refused as a conflict before the deletion, so the resolver forces after it.
      server.failNext = new ConflictError(URI_A, asModelVersion(1), 2);
      server.updateGate = undefined;
      gate.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      expect(server.updates).toBe(1);
   });

   it('fails a save whose document was deleted while it waited for its edits', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      const saving = copy.save();
      await waitFor(() => server.version === 2);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);

      answered.resolve();

      await expect(saving).rejects.toBeInstanceOf(DocumentNotOpenError);
      await written;
      expect(server.saved).toBe(1);
      await expect(copy.edit(root => root)).rejects.toBeInstanceOf(DocumentNotOpenError);
   });

   it('fails a save whose document was opened again while it waited for its edits', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      const saving = copy.save();
      await waitFor(() => server.version === 2);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();

      answered.resolve();

      await expect(saving).rejects.toBeInstanceOf(DocumentNotOpenError);
      await written;
      expect(server.saved).toBe(1);
   });

   it('settles an edit as unavailable when its write conflicts after its close and the end of its session', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'slow' }));
      await waitFor(() => server.updates === 1);
      const closing = copy.close();
      await waitFor(() => copy.clock.pendingTimers() > 0);
      copy.clock.advance(1_000);
      // The session's close waits for the write, so the host ends the session.
      await waitFor(() => copy.snapshot === undefined);
      session.dispose();
      server.failNext = new ConflictError(URI_A, asModelVersion(1), 2);

      answered.resolve();

      expect(await written).toEqual({ status: 'unavailable' });
      await closing.catch(() => undefined);
      // Its reply is written once the test has ended otherwise, on a destroyed stream.
      await waitFor(() => server.sessionsClosed === 1);
      await tick(0);
   });

   it('fails an open whose second read finds the file gone, and opens it again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      server.missing = true;
      await expect(copy.open()).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(copy.snapshot).toBeUndefined();
      await waitFor(() => server.opens.size === 0);

      server.missing = false;
      await copy.open();

      expect(copy.root?.name).toBe('initial');
      expect(server.opens.has(session.clientId)).toBe(true);
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.root?.note === 'theirs');
   });

   it('drops the document when the read after a dropped write finds it gone', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new OneWriteCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      server.missing = true;

      answered.resolve();

      expect(await written).toEqual({ status: 'conflict' });
      expect(copy.snapshot).toBeUndefined();
      await waitFor(() => server.opens.size === 0);
   });

   it('writes the edits of the document opened again one batch at a time once a write from before its deletion fails', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const before = copy.edit(root => ({ ...root, name: 'before' }));
      await waitFor(() => server.updates === 1);
      await server.deleteFile();
      await waitFor(() => copy.snapshot === undefined);
      await copy.open();
      const firstAnswered = new Deferred<void>();
      server.answerGate = firstAnswered.promise;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 2);
      server.answerGate = undefined;
      const second = copy.edit(root => ({ ...root, note: 'second' }));
      server.failNext = new Error('refused');
      server.updateGate = undefined;
      answered.resolve();
      await expect(before).rejects.toThrow('refused');

      const third = copy.edit(root => ({ ...root, name: 'third' }));
      firstAnswered.resolve();

      expect([await first, await second, await third]).toEqual([{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }]);
      expect(server.updates).toBe(3);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'third', note: 'second' });
   });

   it('refuses to open again once closed, during the close or after it', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      const closing = copy.close();
      await expect(copy.open()).rejects.toThrow('closed');
      await closing;
      await expect(copy.open()).rejects.toThrow('closed');

      expect(copy.close()).toBe(closing);
      expect(server.opens.has(session.clientId)).toBe(false);
   });

   it('shows an edit made after its server restarted as unsaved, and saves it', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      for (const name of ['one', 'two', 'three']) {
         const written = copy.edit(root => ({ ...root, name }));
         await written;
         await copy.save();
      }
      const restarted = harness.restart();
      await waitFor(() => restarted.opens.size === 1);

      const written = copy.edit(root => ({ ...root, note: 'after' }));
      await written;

      expect(copy.dirty).toBe(true);
      await copy.save();
      expect(restarted.saved).toBe(restarted.version);
   });

   it('shows a change made while its server was down, and writes its next edit over it', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();

      const restarted = harness.restart({ note: 'external' });
      await waitFor(() => copy.root?.note === 'external');
      const written = copy.edit(root => ({ ...root, name: 'ours' }));

      expect(await written).toEqual({ status: 'applied' });
      expect(restarted.root).toMatchObject({ name: 'ours', note: 'external' });
   });

   it('is clean once its open failed after the server marked the document unsaved', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const opened = copy.open();
      await waitFor(() => server.reads === 1);
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.dirty);

      read.reject(new Error('read failed'));
      await expect(opened).rejects.toThrow('read failed');

      expect(copy.dirty).toBe(false);
   });

   it('is clean once its server restarted clean while a write was out that then failed', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      for (const name of ['one', 'two', 'three']) {
         const written = copy.edit(root => ({ ...root, name }));
         await written;
      }

      const restarted = harness.restart();
      restarted.failNext = new Error('refused');
      const written = copy.edit(root => ({ ...root, note: 'refused' }));
      await expect(written).rejects.toThrow('refused');
      await waitFor(() => restarted.reads > 1);

      expect(copy.dirty).toBe(false);
   });

   it('keeps a change made while its server was down under an edit queued before', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const written = copy.edit(root => ({ ...root, name: 'ours' }));

      const restarted = harness.restart({ note: 'external' });
      await waitFor(() => restarted.reads > 1);
      await written;

      expect(restarted.root).toMatchObject({ name: 'ours', note: 'external' });
   });

   it('keeps its later edit when the echo of its earlier write arrives after both answered', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await first;
      const echo = copy.snapshot;
      const second = copy.edit(root => ({ ...root, name: 'second' }));
      await second;

      const heard = nextUpdate(events);
      await server.push(echo ?? { uri: URI_A }, session.clientId);
      await heard;

      expect(copy.root?.name).toBe('second');
   });

   it('keeps its write when a push with an older model but newer text arrives while the write is out', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const before = copy.snapshot ?? { uri: URI_A };
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.version === 2);

      // The server sends a build behind the text it holds, here the text of a
      // change not built yet.
      const heard = nextUpdate(events);
      await server.push({ ...before, text: { version: 3, hash: 'unbuilt', dirty: true } }, OTHER_CLIENT);
      await heard;
      answered.resolve();
      await written;

      expect(copy.root?.name).toBe('ours');
   });

   it('keeps a change made while its server was down under an edit written during the reconnect', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();

      const restarted = harness.restart({ note: 'external' });
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await written;

      expect(restarted.root).toMatchObject({ name: 'ours', note: 'external' });
   });

   it('does not save a change made while its server was down that it has not shown', async () => {
      const harness = makeCopyHarness();
      harness.server.saved = 0;
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      expect(copy.dirty).toBe(true);

      const restarted = harness.restart({ note: 'external' });
      restarted.saved = 0;
      const saved = copy.save();

      await expect(saved).rejects.toThrow(ConflictError);
      expect(restarted.saved).toBe(0);
      await waitFor(() => restarted.reads > 1);
   });

   it('keeps a change made while its server was down under a split batch whose read after the conflict answers before the restart', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldResolverCopy(harness.session, harness.events, 1);
      await copy.open();
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'ours' }));
      await harness.server.foreignWrite({ name: 'theirs' });
      await copy.resolver.held.promise;

      // At version 2 by chance, the version the split would be gated on.
      const restored = new Deferred<void>();
      harness.session.onDidRestoreDocument(() => restored.resolve());
      const restarted = harness.restart({ note: 'external' });
      restarted.version = 2;
      restarted.saved = 2;
      await restored.promise;
      copy.resolver.merge.resolve();

      expect(await name).toEqual({ status: 'conflict' });
      await note;
      expect(restarted.root.note).toBe('external');
   });

   it('keeps a change made while its server was down under an edit typed as the restore fires', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const first = copy.edit(root => ({ ...root, name: 'one' }));
      await first;

      // The restarted server reaches the old version with the write sent
      // during the reconnect, so the typed edit's version matches there.
      const restarted = harness.restart({ note: 'external' });
      let typed: Promise<WorkingCopyEditOutcome> | undefined;
      harness.session.onDidRestoreDocument(() => {
         typed = copy.edit(root => ({ ...root, name: 'typed' }));
      });
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await written;
      await waitFor(() => typed !== undefined);
      await typed;

      expect(restarted.root).toMatchObject({ name: 'typed', note: 'external' });
   });

   it('keeps a change made while its server was down under an edit typed as the restore fires during a write that fails', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();

      const restarted = harness.restart({ note: 'external' });
      restarted.failNext = new Error('refused');
      let typed: Promise<WorkingCopyEditOutcome> | undefined;
      harness.session.onDidRestoreDocument(() => {
         typed = copy.edit(root => ({ ...root, name: 'typed' }));
      });
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await expect(written).rejects.toThrow('refused');
      await waitFor(() => typed !== undefined);
      await typed;

      expect(restarted.root).toMatchObject({ name: 'typed', note: 'external' });
   });

   it('resolves the open its restore took over when its server restarts during the second read', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      harness.server.readGate = new Deferred<void>().promise;
      const opened = copy.open();
      await waitFor(() => harness.server.reads === 1);
      const restarted = harness.restart({ note: 'external' });

      await opened;
      await waitFor(() => copy.snapshot?.model?.root.note === 'external', { message: 'the copy never took the restored document' });
      // The restore's read and the copy's own, so the test ends after both answered.
      await waitFor(() => restarted.reads >= 2);
      await tick(20);
      expect(restarted.opens.size).toBe(1);
   });

   it('resolves the open its restore took over when its connection drops during the second read and the text is unchanged', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      harness.server.readGate = new Deferred<void>().promise;
      const opened = copy.open();
      await waitFor(() => harness.server.reads === 1);
      const restarted = harness.restart();

      await opened;
      expect(copy.snapshot).toBeDefined();
      await waitFor(() => restarted.reads >= 2);
      await tick(20);
      expect(restarted.opens.size).toBe(1);
   });

   it('reports a conflict for an edit that restates a value its write before lost to another client', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, name: 'x' }));
      await waitFor(() => server.updates === 1);
      const again = copy.edit(root => ({ ...root, name: 'x' }));
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });

      held.resolve();

      expect(await first).toEqual({ status: 'conflict' });
      expect(await again).toEqual({ status: 'conflict' });
      expect(server.root.name).toBe('theirs');
      expect(copy.root?.name).toBe('theirs');
   });

   it('reports a conflict for an edit that reverts a value its write before lost to another client', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const original = server.root.name;
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, name: 'x' }));
      await waitFor(() => server.updates === 1);
      const reverted = copy.edit(root => ({ ...root, name: original }));
      const other = copy.edit(root => ({ ...root, note: 'n' }));
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });

      held.resolve();

      expect([await first, await reverted, await other]).toEqual([{ status: 'conflict' }, { status: 'conflict' }, { status: 'merged' }]);
      expect(server.root).toMatchObject({ name: 'theirs', note: 'n' });
   });

   it('reports a conflict for an edit restating a value its write before lost, and merges another field batched with it', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, name: 'x' }));
      await waitFor(() => server.updates === 1);
      const again = copy.edit(root => ({ ...root, name: 'x' }));
      const other = copy.edit(root => ({ ...root, note: 'n' }));
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });

      held.resolve();

      expect([await first, await again, await other]).toEqual([{ status: 'conflict' }, { status: 'conflict' }, { status: 'merged' }]);
      expect(server.root).toMatchObject({ name: 'theirs', note: 'n' });
   });

   it('writes an edit typed during a write that a conflict dropped in part, over the field that write merged', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const dropped = copy.edit(root => ({ ...root, name: 'x' }));
      const merged = copy.edit(root => ({ ...root, note: 'n' }));
      await waitFor(() => server.updates === 1);
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });
      const typed = copy.edit(root => ({ ...root, note: 'n2' }));

      held.resolve();

      expect([await dropped, await merged]).toEqual([{ status: 'conflict' }, { status: 'merged' }]);
      expect(await typed).toEqual({ status: 'merged' });
      expect(server.root).toMatchObject({ name: 'theirs', note: 'n2' });
   });

   it('settles a split batch and the edit queued behind it when a kept edit throws without a dropped one', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const dropped = copy.edit(root => ({ ...root, note: 'n' }));
      const kept = copy.edit(root => {
         if (root.note !== 'n' && root.note !== 'theirs') {
            throw new TypeError('no note');
         }
         return { ...root, name: 'x' };
      });
      await waitFor(() => server.updates === 1);
      server.updateGate = undefined;
      await server.foreignWrite({ note: 'theirs' });
      const queued = copy.edit(root => ({ ...root, name: 'queued' }));

      held.resolve();

      expect([await dropped, await kept]).toEqual([{ status: 'conflict' }, { status: 'merged' }]);
      // Measured without the batch, the queued edit of the merged field conflicts.
      expect(await queued).toEqual({ status: 'conflict' });
      expect(server.root).toMatchObject({ name: 'x', note: 'theirs' });
      expect(copy.hasWritesInFlight).toBe(false);
   });

   it('refuses to save text it never showed after a restore whose reads failed', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      await harness.server.foreignWrite({ name: 'seen' });
      await waitFor(() => copy.snapshot?.model?.version === 2 && copy.dirty);
      const restarted = harness.restart({ note: 'unseen' });
      // The restarted server holds unsaved text at the version the copy holds, by chance.
      restarted.version = 2;
      restarted.saved = 1;
      const failed = Promise.reject(new Error('read failed'));
      failed.catch(() => undefined);
      restarted.buildGate = failed;
      let restored = 0;
      harness.session.onDidRestoreDocument(() => restored++);
      void harness.session.connected().catch(() => undefined);
      await waitFor(() => restored === 1 && restarted.reads >= 2);
      await tick(20);
      expect(copy.snapshot?.model?.root.note).toBe('initial');

      await expect(copy.save()).rejects.toBeInstanceOf(ConflictError);
      expect(restarted.saved).toBe(1);
   });

   it("shows the restarted server's update at a version below the snapshot's after a restore whose reads failed", async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      await harness.server.foreignWrite({ name: 'seen' });
      await harness.server.foreignWrite({ name: 'seen again' });
      await waitFor(() => copy.snapshot?.model?.version === 3);
      const restarted = harness.restart({ note: 'unseen' });
      const failed = Promise.reject(new Error('read failed'));
      failed.catch(() => undefined);
      restarted.buildGate = failed;
      let restored = 0;
      harness.session.onDidRestoreDocument(() => restored++);
      void harness.session.connected().catch(() => undefined);
      await waitFor(() => restored === 1 && restarted.reads >= 2);
      await tick(20);
      restarted.buildGate = undefined;

      await restarted.foreignWrite({ name: 'after' });

      await waitFor(() => copy.root?.name === 'after');
      expect(copy.snapshot?.model?.version).toBeLessThan(3);
   });

   it('applies an edit made on the restored document as the restore fires, with nothing changed meanwhile', async () => {
      const harness = makeCopyHarness();
      const copy = new OneWriteCopy(harness.session, harness.events, URI_A);
      await copy.open();
      let typed: Promise<WorkingCopyEditOutcome> | undefined;
      // After the copy's own listener, so the copy has taken the restored document.
      harness.session.onDidRestoreDocument(() => {
         typed = copy.edit(root => ({ ...root, name: 'typed' }));
      });
      const restarted = harness.restart();
      await waitFor(() => typed !== undefined);

      expect(await typed).toEqual({ status: 'applied' });
      expect(restarted.root.name).toBe('typed');
   });

   it('holds the document a restore read while a write is out, and shows it once the write answers', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      harness.restart({ name: 'down' });
      let shown: string | undefined;
      harness.session.onDidRestoreDocument(() => {
         shown = copy.root?.name;
      });

      const written = copy.edit(root => ({ ...root, note: 'mine' }));
      await waitFor(() => shown !== undefined);

      expect(shown).toBe('initial');
      expect(await written).toEqual({ status: 'merged' });
      expect(copy.root).toMatchObject({ name: 'down', note: 'mine' });
   });

   it('applies an edit typed as a reconnect that found its text unchanged fires, on the base from before it', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restarted = harness.restart();
      // The write before fails, so the typed edit keeps the base from before the reconnect.
      restarted.failNext = new Error('refused');
      let typed: Promise<WorkingCopyEditOutcome> | undefined;
      harness.session.onDidRestoreDocument(() => {
         typed = copy.edit(root => ({ ...root, name: 'typed' }));
      });
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await expect(written).rejects.toThrow('refused');
      await waitFor(() => typed !== undefined);

      expect(await typed).toEqual({ status: 'applied' });
      expect(restarted.root.name).toBe('typed');
   });

   it('shows the diagnostics its reread after a restore brings', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const shown: number[] = [];
      copy.onDidChange(() => shown.push(copy.diagnostics.length));
      const restarted = harness.restart({ note: 'external' });
      restarted.problems = [PROBLEM];
      await waitFor(() => shown.at(-1) === 1);

      expect(copy.diagnostics).toEqual([PROBLEM]);
   });

   it('keeps showing its diagnostics through a restore until its reread answers', async () => {
      const harness = makeCopyHarness();
      harness.server.problems = [PROBLEM];
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const shown: number[] = [];
      copy.onDidChange(() => shown.push(copy.diagnostics.length));
      const restarted = harness.restart({ note: 'external' });
      // Told apart from the ones held, so only the reread can show it.
      const fresh = { ...PROBLEM, message: 'fresh' };
      restarted.problems = [fresh];

      await waitFor(() => copy.diagnostics[0]?.message === 'fresh', { message: 'the reread never answered' });

      expect(copy.snapshot?.model?.root.note).toBe('external');
      expect(shown).not.toContain(0);
   });

   it('ends its open when its restore could not open the document again', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const queued = copy.edit(root => ({ ...root, name: 'ours' }));

      const restarted = harness.restart();
      const refused = Promise.reject(new Error('open refused'));
      refused.catch(() => undefined);
      restarted.openGate = refused;

      expect(await queued).toEqual({ status: 'unavailable' });
      expect(copy.snapshot).toBeUndefined();
      restarted.openGate = undefined;
      await copy.open();
      expect(copy.snapshot).toBeDefined();
   });

   it('reports conflict for an edit queued before its server went down of a field changed meanwhile', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const written = copy.edit(root => ({ ...root, name: 'ours' }));

      const restarted = harness.restart({ name: 'theirs' });
      await waitFor(() => restarted.reads > 1);

      expect(await written).toEqual({ status: 'conflict' });
      expect(restarted.root.name).toBe('theirs');
      expect(copy.root?.name).toBe('theirs');
   });

   it('keeps a change made while its server was down under an edit made after the restore failed to read', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();

      const restarted = harness.restart({ note: 'external' });
      const failing = Promise.reject(new Error('read failed'));
      failing.catch(() => undefined);
      restarted.buildGate = failing;
      // The restore's read and the copy's reread after it.
      await waitFor(() => restarted.reads > 1);
      restarted.buildGate = undefined;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await written;

      expect(restarted.root).toMatchObject({ name: 'ours', note: 'external' });
   });
});
