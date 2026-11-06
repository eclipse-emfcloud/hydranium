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
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { DataConnection } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DataSession, type DataSessionHost } from '../../src/client/data-session';
import { type WorkingCopyChangeReason, type WorkingCopyEditOutcome, WorkingCopy } from '../../src/client/working-copy';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '../../src/data';
import { ConflictError, DocumentNotOpenError, SaveFailedError } from '../../src/errors';
import { asModelVersion } from '../../src/model-service/base-version';
import { ForceConflictResolver, type ReconcileOutcome, ReconcilingConflictResolver } from '../../src/patch-merge';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { randomUuid } from '../../src/random-uuid';
import { makeFakeDataPort } from '../../src/testing/data-doubles';
import { type FakeClock, makeFakeClock } from '../../src/testing/fake-clock';
import { captureUnhandledRejections, makeDuplexConnectionPair } from '../../src/testing/node';
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
   items?: readonly ProbeItem[];
}

interface ProbeItem {
   id?: string;
   label: string;
}

/** Matches an item of `items` by its id, and nothing else. */
const itemKey = (item: unknown): string | undefined =>
   typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? item.id : undefined;

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
   /** Refuses the next read. */
   failRead?: Error;
   /** Refuses the next write before it lands. */
   failNext?: Error;
   /** Refuses the write with this number, counted from one, before it lands. */
   failAt?: number;
   /** The diagnostics a validated read carries. */
   problems: TransferDiagnostic[] = [];
   /** The document is validated, so a read carries its diagnostics also unasked, as the server's does. */
   validated = true;
   /** Reads answer that the document does not exist. */
   missing = false;
   /** Added to the text version for the model's, as a server that numbers the two apart. */
   modelOffset = 0;
   /** Run in the task after a watched open answered, as a change landing once the server answered. */
   afterWatchedOpen?: () => Promise<void>;
   /** Run once a watched open has read its answer and before it answers, as a change landing then, whose events reach the client first. */
   beforeWatchedAnswer?: () => Promise<void>;
   /** Answers a watched open as a plain one, without `sequence`, as a server that ignores `watch`. */
   ignoresWatch = false;
   /** Run when a watch request arrives, before it is placed. */
   beforeWatch?: () => void;
   /** Applied to a write's model before it lands, as a server that computes values. */
   compute?: (root: ProbeElement) => ProbeElement;
   protected sequence = 0;
   /** Each numbered write that landed, at the version its text took. */
   protected readonly writes: { readonly clientId: string; readonly write: number; readonly version: number }[] = [];
   /** Reports the numbered writes a document holds, as a server keeping the contract does. Off, documents carry no `heldWrites`, as from a server before it. */
   reportsWrites = true;

   /** The epoch is another for each server, so a restarted one refuses the versions of the one before. */
   constructor(
      protected readonly connection: MessageConnection,
      readonly epoch: string = randomUuid()
   ) {
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

   async createSession(): Promise<{ epoch: string }> {
      return { epoch: this.epoch };
   }

   async closeSession(): Promise<void> {
      this.sessionsClosed++;
   }

   /** With `watch`, the open reads as {@link getModelDocument} does, in the same request, and is undone when that fails. */
   async openModelDocument(args: { clientId: string; watch?: boolean; includeDiagnostics?: boolean }): Promise<unknown> {
      await this.openGate;
      const sequence = this.sequence;
      const wasOpen = this.opens.has(args.clientId);
      this.opens.add(args.clientId);
      if (!args.watch || this.ignoresWatch) {
         return this.document();
      }
      try {
         // With the position of the last event sent when the request began, as a server that watches answers.
         const answer = { ...((await this.getModelDocument(args)) as object), sequence };
         const before = this.beforeWatchedAnswer;
         this.beforeWatchedAnswer = undefined;
         await before?.();
         const after = this.afterWatchedOpen;
         this.afterWatchedOpen = undefined;
         if (after) {
            setImmediate(() => void after());
         }
         return answer;
      } catch (error: unknown) {
         if (!wasOpen) {
            this.opens.delete(args.clientId);
         }
         throw error;
      }
   }

   async watchModelDocument(): Promise<unknown> {
      this.beforeWatch?.();
      return { uri: URI_A, epoch: this.epoch, exists: true, sequence: this.sequence, text: this.document().text };
   }

   async getModelDocument(args: { includeDiagnostics?: boolean }): Promise<unknown> {
      this.reads++;
      const failure = this.failRead;
      if (failure) {
         this.failRead = undefined;
         throw failure;
      }
      // Each gate holds the requests received after a test set it.
      const readGate = this.readGate;
      await this.buildGate;
      const answer = this.missing ? { uri: URI_A, epoch: this.epoch } : this.document((args.includeDiagnostics ?? false) || this.validated);
      await readGate;
      // As the server's, the text is read when the answer is sent.
      return 'text' in answer ? { ...answer, text: this.document().text } : answer;
   }

   async closeModelDocument(args: { clientId: string }): Promise<void> {
      this.opens.delete(args.clientId);
   }

   async updateModelDocument(args: {
      clientId: string;
      baseVersion: number | 'any';
      baseEpoch?: string;
      model: ProbeElement;
      write?: number;
   }): Promise<unknown> {
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
      // Before the open, as a data server checks it.
      if (args.baseVersion !== 'any' && args.baseEpoch !== this.epoch) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.modelVersion);
      }
      if (!this.opens.has(args.clientId)) {
         throw new DocumentNotOpenError(URI_A, args.clientId);
      }
      if (args.baseVersion !== 'any' && args.baseVersion !== this.modelVersion) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.modelVersion);
      }
      // Read before the pushes are awaited, so a write of another client that lands meanwhile is not answered as this one.
      const pushed = this.change(this.compute?.(args.model) ?? args.model, args.clientId, args.write);
      const written = { version: this.modelVersion };
      const answer = this.document();
      await pushed;
      await answerGate;
      return { ...(this.answerLatest ? this.document() : answer), written };
   }

   async persistModelDocument(args: { clientId: string; baseVersion: number; baseEpoch: string }): Promise<unknown> {
      const answerGate = this.answerGate;
      const saveGate = this.saveGate;
      if (args.baseEpoch !== this.epoch) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.modelVersion);
      }
      if (!this.opens.has(args.clientId)) {
         throw new DocumentNotOpenError(URI_A, args.clientId);
      }
      if (args.baseVersion !== this.modelVersion) {
         throw new ConflictError(URI_A, asModelVersion(args.baseVersion), this.modelVersion);
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

   /** Write `root` as another client whose push has not reached the copy yet. */
   unpushedWrite(root: Partial<ProbeElement>): void {
      this.root = { ...this.root, ...root };
      this.version++;
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

   protected async change(root: ProbeElement, sourceClientId: string, write?: number): Promise<void> {
      // As the server does, a write that changes no text makes no version.
      if (compare(this.root, root).length === 0) {
         if (write !== undefined) {
            this.writes.push({ clientId: sourceClientId, write, version: this.modelVersion });
         }
         return;
      }
      const wasDirty = this.version !== this.saved;
      this.root = root;
      this.version++;
      if (write !== undefined) {
         this.writes.push({ clientId: sourceClientId, write, version: this.modelVersion });
      }
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

   get modelVersion(): number {
      return this.version + this.modelOffset;
   }

   /** The document as it is now, with diagnostics unless a read did not ask for them. */
   protected document(withDiagnostics = true): TransferDocument<ProbeElement> {
      const held = new Map<string, number>();
      for (const { clientId, write, version } of this.writes) {
         if (version <= this.modelVersion) {
            held.set(clientId, Math.max(held.get(clientId) ?? write, write));
         }
      }
      const heldWrites = Object.fromEntries(held);
      const document: TransferDocument<ProbeElement> = {
         uri: URI_A,
         epoch: this.epoch,
         heldWrites,
         model: {
            root: this.root,
            ...(withDiagnostics ? { diagnostics: this.problems } : {}),
            version: asModelVersion(this.modelVersion),
            // As the server's, an equal hash means equally validated.
            hash: JSON.stringify([this.root, withDiagnostics ? this.problems : undefined])
         },
         text: { version: this.version, hash: JSON.stringify(this.root), dirty: this.version !== this.saved }
      };
      if (!this.reportsWrites) {
         // As a server from before the field sends it, which the type does not allow.
         Reflect.deleteProperty(document, 'heldWrites');
      }
      return document;
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

/** A {@link ForceCopy} that gives up after the first conflicting write. */
class ForceOneWriteCopy extends ForceCopy {
   protected override readonly maxWrites = 1;
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
   /**
    * Drop the connection and serve the next one from the same server, which
    * keeps its epoch, versions and text but not the sessions of the dropped
    * connection.
    */
   reconnect(): ProbeServer;
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

/** A session whose restore waits for the diagnostics. */
class DiagnosticsRestoreSession extends DataSession<ProbeElement> {
   protected override readonly restoreWithDiagnostics = true;
}

/** `settleBeforeCloseMs`, when given, bounds the session's wait before a close. */
function makeCopyHarness(settleBeforeCloseMs?: number, restoreWithDiagnostics = false): CopyHarness {
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
      settleBeforeCloseMs !== undefined
         ? { sessionFactory: (clientId, host, label) => new ClosingSession(clientId, host, label, settleBeforeCloseMs) }
         : restoreWithDiagnostics
           ? { sessionFactory: (clientId, host, label) => new DiagnosticsRestoreSession(clientId, host, label) }
           : {}
   );
   let disposed = false;
   /** Drop the connection and serve the next one from what `make` builds on it. */
   const serveNext = (make: (wire: MessageConnection) => ProbeServer): ProbeServer => {
      const replaced = makeDuplexConnectionPair();
      pairs.push(replaced);
      server = make(replaced.left);
      next = replaced.right;
      port.fireDispose();
      // Ends only, as a reply still being written would fail on a destroyed stream.
      pair.left.dispose();
      pair.right.dispose();
      pair = replaced;
      return server;
   };
   const harness: CopyHarness = {
      server,
      session: connection.createSession('form', 'form'),
      events,
      restart: root => {
         const held = server.root;
         return serveNext(wire => {
            const restarted = new ProbeServer(wire);
            restarted.root = { ...held, ...root };
            return restarted;
         });
      },
      reconnect: () => {
         const before = server;
         return serveNext(wire => {
            const same = new ProbeServer(wire, before.epoch);
            same.root = before.root;
            same.version = before.version;
            same.saved = before.saved;
            return same;
         });
      },
      dispose: () => {
         if (disposed) {
            return;
         }
         disposed = true;
         connection.dispose();
         // Ends only, as for a dropped connection.
         pairs.forEach(each => {
            each.left.dispose();
            each.right.dispose();
         });
      }
   };
   harnesses.push(harness);
   return harness;
}

/**
 * Type an edit while the connection is down, on the base from before the
 * restart, so its write reaches the restarted server gated on the epoch before.
 */
function typeWhileDown(copy: WorkingCopy<ProbeElement>): Promise<WorkingCopyEditOutcome> {
   return copy.edit(root => ({ ...root, name: 'typed' }));
}

/**
 * A copy matching `items` by key whose first edit, to `ours`, another
 * client's write of `theirs` drops while it is out. `release` lets the write
 * answer, so an edit made before it is written after the drop.
 */
async function keyedDrop(items: readonly ProbeItem[], ours: readonly ProbeItem[], theirs: readonly ProbeItem[]) {
   const { server, session, events } = makeCopyHarness();
   server.root = { ...server.root, items };
   const copy = new HeldCopy(session, events, URI_A, { itemKey });
   await copy.open();
   const opened = copy.root!;
   const answered = new Deferred<void>();
   server.updateGate = answered.promise;
   const first = copy.editRoot(opened, { ...opened, items: ours });
   await waitFor(() => server.updates === 1);
   await server.foreignWrite({ items: theirs });
   const release = (): void => {
      server.updateGate = undefined;
      answered.resolve();
   };
   return { server, copy, first, release };
}

/** Resolves once the session has restored a document. */
function nextRestore(session: DataSession<ProbeElement>): Promise<void> {
   const restored = new Deferred<void>();
   const listening = session.onDidRestoreDocument(() => {
      listening.dispose();
      restored.resolve();
   });
   return restored.promise;
}

/**
 * Resolves once the session has heard the next update of the document from
 * `sourceClientId`, so a late echo of the copy's own write is not taken for it.
 */
function nextUpdate(events: DataEvents<ProbeElement>, sourceClientId = OTHER_CLIENT): Promise<void> {
   const heard = new Deferred<void>();
   const listener = events.onDidUpdateDocument(event => {
      if (event.sourceClientId === sourceClientId) {
         listener.dispose();
         heard.resolve();
      }
   });
   return heard.promise;
}

/** Where a fault strikes an edit's write: at each await of the write that another request can pass. */
const FAULT_POINTS = [
   'before the write lands',
   'once the write landed, before it answers',
   'while a conflict of the write rereads'
] as const;

/** What strikes, resolving to the server serving once it struck. */
const FAULTS = {
   'another client writes': async (_harness: CopyHarness, server: ProbeServer): Promise<ProbeServer> => {
      await server.foreignWrite({ name: 'theirs' });
      return server;
   },
   'the server restarts': async (harness: CopyHarness): Promise<ProbeServer> => harness.restart(),
   'the connection drops': async (harness: CopyHarness): Promise<ProbeServer> => harness.reconnect(),
   'the copy closes': async (_harness: CopyHarness, server: ProbeServer, copy: WorkingCopy<ProbeElement>): Promise<ProbeServer> => {
      copy.dispose();
      return server;
   },
   'the next write is refused': async (_harness: CopyHarness, server: ProbeServer): Promise<ProbeServer> => {
      server.failNext = new Error('refused');
      return server;
   }
} as const;

describe('WorkingCopy under a fault at each await of a write', () => {
   afterEach(() => {
      copies.splice(0).forEach(copy => copy.dispose());
      harnesses.splice(0).forEach(harness => harness.dispose());
   });

   const cases = FAULT_POINTS.flatMap(point => Object.keys(FAULTS).map(fault => [point, fault as keyof typeof FAULTS] as const));

   it.each(cases)('shows an edit that is not idempotent once at most, and follows the server, when %s and %s', async (point, fault) => {
      const rejections = await captureUnhandledRejections(async caught => {
         const harness = makeCopyHarness();
         const copy = new HeldCopy(harness.session, harness.events, URI_A);
         await copy.open();
         const shown: string[] = [];
         copy.onDidChange(() => shown.push(copy.root?.note ?? ''));
         const server = harness.server;
         const gate = new Deferred<void>();
         if (point === 'once the write landed, before it answers') {
            server.answerGate = gate.promise;
         } else {
            server.updateGate = gate.promise;
         }

         const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
         if (point === 'once the write landed, before it answers') {
            await waitFor(() => server.root.note === 'initial!');
         } else {
            await waitFor(() => server.updates === 1);
         }
         const rereading = new Deferred<void>();
         if (point === 'while a conflict of the write rereads') {
            await server.foreignWrite({ note: 'conflicting' });
            const reads = server.reads;
            server.readGate = rereading.promise;
            gate.resolve();
            await waitFor(() => server.reads > reads);
         }
         const serving = await FAULTS[fault](harness, server, copy);
         gate.resolve();
         rereading.resolve();
         await written.catch(() => undefined);
         await tick();

         expect(shown.filter(note => (note.match(/!/g)?.length ?? 0) > 1)).toEqual([]);
         if (fault !== 'the copy closes') {
            await waitFor(() => compare(copy.root ?? {}, serving.root).length === 0);
            expect(serving.root.note.match(/!/g)?.length ?? 0).toBeLessThanOrEqual(1);
         }
         return caught;
      });

      expect(rejections).toEqual([]);
   });
});

/** Where a fault strikes the open of a copy: at each await of it that another request can pass. */
const OPEN_FAULT_POINTS = [
   'while the open reads',
   'while the read after a change heard during the open reads',
   'while the read of a server that ignores watch reads'
] as const;

/** What strikes the open, resolving to the server serving once it struck. */
const OPEN_FAULTS = {
   nothing: async (_harness: CopyHarness, server: ProbeServer): Promise<ProbeServer> => server,
   ...FAULTS,
   // Closed rather than disposed, as a dispose leaves the document open for the edits still unanswered.
   'the copy closes': async (_harness: CopyHarness, server: ProbeServer, copy: WorkingCopy<ProbeElement>): Promise<ProbeServer> => {
      void copy.close();
      return server;
   },
   'the file is deleted': async (_harness: CopyHarness, server: ProbeServer): Promise<ProbeServer> => {
      await server.deleteFile();
      return server;
   },
   'the session ends': async (harness: CopyHarness, server: ProbeServer): Promise<ProbeServer> => {
      harness.session.dispose();
      return server;
   }
} as const;

describe('WorkingCopy under a fault at each await of its open', () => {
   afterEach(() => {
      copies.splice(0).forEach(copy => copy.dispose());
      harnesses.splice(0).forEach(harness => harness.dispose());
   });

   const cases = OPEN_FAULT_POINTS.flatMap(point =>
      Object.keys(OPEN_FAULTS)
         .filter(fault => fault !== 'the next write is refused')
         .map(fault => [point, fault as keyof typeof OPEN_FAULTS] as const)
   );

   it.each(cases)('follows the server once open, and leaves nothing open otherwise, %s and %s', async (point, fault) => {
      const rejections = await captureUnhandledRejections(async caught => {
         const harness = makeCopyHarness();
         const server = harness.server;
         const held = new Deferred<void>();
         if (point === 'while the open reads') {
            server.readGate = held.promise;
         } else if (point === 'while the read of a server that ignores watch reads') {
            server.ignoresWatch = true;
            server.readGate = held.promise;
         } else {
            server.beforeWatchedAnswer = async () => {
               await server.foreignWrite({ note: 'heard' });
               server.readGate = held.promise;
            };
         }
         const copy = new HeldCopy(harness.session, harness.events, URI_A);
         const opened = copy.open().then(
            () => true,
            () => false
         );
         await waitFor(() => server.reads === (point === 'while the read after a change heard during the open reads' ? 2 : 1));

         const serving = await OPEN_FAULTS[fault](harness, server, copy);
         held.resolve();
         const open = await opened;
         await tick();

         if (fault === 'the session ends') {
            expect({ open, snapshot: copy.snapshot, sessionsClosed: serving.sessionsClosed }).toEqual({
               open: false,
               snapshot: undefined,
               sessionsClosed: 1
            });
         } else if (open && fault !== 'the copy closes') {
            await waitFor(() => compare(copy.root ?? {}, serving.root).length === 0 && serving.opens.size === 1, {
               message: 'the copy does not follow the document the server holds open'
            });
         } else {
            await waitFor(() => serving.opens.size === 0, { message: 'the server holds an open no copy follows' });
            expect(copy.snapshot).toBeUndefined();
         }
         return caught;
      });

      expect(rejections).toEqual([]);
   });
});

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

   it('takes a change whose events arrive before its open answers', async () => {
      const { server, session, events } = makeCopyHarness();
      server.beforeWatchedAnswer = () => server.foreignWrite({ note: 'theirs' });
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      await waitFor(() => copy.root?.note === 'theirs', { message: 'the copy kept the state its open answered' });
      expect({ version: copy.snapshot?.model?.version, dirty: copy.dirty }).toEqual({ version: server.modelVersion, dirty: true });
   });

   it('fails an open whose read after a change heard before its answer failed, and opens it again', async () => {
      const { server, session, events } = makeCopyHarness();
      server.beforeWatchedAnswer = async () => {
         await server.foreignWrite({ note: 'theirs' });
         const failed = Promise.reject(new Error('read failed'));
         failed.catch(() => undefined);
         server.readGate = failed;
      };
      const copy = new HeldCopy(session, events, URI_A);

      await expect(copy.open()).rejects.toThrow('read failed');
      expect(copy.snapshot).toBeUndefined();
      await waitFor(() => server.opens.size === 0);

      server.readGate = undefined;
      await copy.open();
      expect(copy.root?.note).toBe('theirs');
   });

   it.each([
      ['its server restarts', { note: 'external' }],
      ['its connection drops and the text is unchanged', undefined]
   ] as const)(
      'resolves the open its restore took over when %s during the read after a change heard before its answer',
      async (_how, root) => {
         const harness = makeCopyHarness();
         harness.server.beforeWatchedAnswer = async () => {
            await harness.server.foreignWrite({ note: 'theirs' });
            harness.server.readGate = new Deferred<void>().promise;
         };
         const copy = new HeldCopy(harness.session, harness.events, URI_A);
         const opened = copy.open();
         await waitFor(() => harness.server.reads === 2);
         const restarted = harness.restart(root);

         await opened;
         await waitFor(() => copy.snapshot?.model?.root.note === (root?.note ?? 'theirs'), {
            message: 'the copy never took the restored document'
         });
         // The restore's read, whose validated answer the copy takes without its own.
         await waitFor(() => restarted.reads >= 1);
         await tick(20);
         expect(restarted.opens.size).toBe(1);
      }
   );

   it('takes a save whose event arrives before its open answers', async () => {
      const { server, session, events } = makeCopyHarness();
      await server.foreignWrite({ note: 'theirs' });
      server.beforeWatchedAnswer = () => server.foreignSave();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      await waitFor(() => !copy.dirty, { message: 'the copy kept the dirty flag its open answered' });
   });

   it('saves the text the server holds dirty when it opens', async () => {
      const { server, session, events } = makeCopyHarness();
      await server.foreignWrite({ note: 'theirs' });
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      const dirty = copy.dirty;
      await copy.save();

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

   it("tells its own edit and the answer to it apart from another client's update", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));

      expect(await copy.edit(root => ({ ...root, note: 'ours' }))).toEqual({ status: 'applied' });
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;

      expect(reasons).toEqual(['edited', 'written', 'changed']);
   });

   it("announces the answer to its write as changed when it holds another client's write too", async () => {
      const { server, session, events } = makeCopyHarness();
      server.answerLatest = true;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;

      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.version === 2);
      await server.foreignWrite({ name: 'theirs' });
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(reasons.at(-1)).toBe('changed');
      expect(copy.root).toMatchObject({ name: 'theirs', note: 'ours' });
   });

   it('announces the answer to a write that met a conflict as changed', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;

      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      answered.resolve();

      expect(await written).toEqual({ status: 'merged' });
      expect(reasons.at(-1)).toBe('changed');
   });

   it('announces its own write as written once, where the server computes a value its echo brings first', async () => {
      const { server, session, events } = makeCopyHarness();
      server.compute = root => ({ ...root, name: `computed-${root.note}` });
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(event => shown.push(`${event.reason}:${copy.root?.name}`));

      expect(await copy.edit(root => ({ ...root, note: 'ours' }))).toEqual({ status: 'applied' });

      expect(shown).toEqual(['edited:initial', 'written:computed-ours']);
   });

   it('announces its own echo as changed once the write it holds out fails', async () => {
      const { server, session, events } = makeCopyHarness();
      server.compute = root => ({ ...root, name: `computed-${root.note}` });
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(event => shown.push(`${event.reason}:${copy.root?.name}`));
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;

      const heard = nextUpdate(events, session.clientId);
      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await heard;
      expect(shown).toEqual(['edited:initial']);
      answered.reject(new Error('refused after it landed'));

      await expect(written).rejects.toThrow('refused after it landed');
      expect(shown).toEqual(['edited:initial', 'changed:computed-ours']);
   });

   it('announces a write its session made past it as changed', async () => {
      const { session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));

      const heard = nextUpdate(events, session.clientId);
      await session.updateDocument({ uri: URI_A, model: { $type: 'TypeOne', name: 'past', note: 'initial' }, baseVersion: 'any' });
      await heard;

      expect(reasons).toEqual(['changed']);
      expect(copy.root?.name).toBe('past');
   });

   it("announces the answer to its write as changed when another client's newer update came first", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;

      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(reasons.at(-1)).toBe('changed');
      expect(copy.root).toMatchObject({ name: 'theirs', note: 'ours' });
   });

   it('announces nothing past the edit for a batch that changes nothing', async () => {
      const { session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));

      expect(await copy.edit(root => ({ ...root }))).toEqual({ status: 'unchanged' });

      expect(reasons).toEqual(['edited']);
   });

   it("announces a write as changed once another client's update was undone before its retry", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;

      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      await server.foreignWrite({ name: 'initial' });
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(reasons.at(-1)).toBe('changed');
   });

   it('announces each of two batches as written', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;

      const first = copy.edit(root => ({ ...root, note: 'one' }));
      await waitFor(() => server.updates === 1);
      const second = copy.edit(root => ({ ...root, name: 'two' }));
      server.updateGate = undefined;
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(reasons).toEqual(['edited', 'edited', 'written', 'written']);
   });

   it("announces the answer to its write as changed when another client's update held meanwhile is taken in its place", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const reasons: WorkingCopyChangeReason[] = [];
      copy.onDidChange(event => reasons.push(event.reason));
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;

      const written = copy.edit(root => ({ ...root, note: 'ours' }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(reasons).toEqual(['edited', 'changed']);
      expect(copy.root).toMatchObject({ name: 'theirs', note: 'ours' });
   });

   it("writes an edit made during its write once over another client's update from a server that sends no heldWrites", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;

      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      const second = copy.edit(root => ({ ...root, name: 'second' }));
      answered.resolve();
      await Promise.all([first, second]);
      await tick();

      expect(server.root.note).toBe('initial!');
      expect(copy.root).toEqual(server.root);
   });

   it('writes an edit made during its write once to a server that sends no heldWrites', async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      await tick();

      const second = copy.edit(root => ({ ...root, name: 'second' }));
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'second', note: 'initial!' });
   });

   it("holds another client's update from a server that sends no heldWrites while its write is out, so an edit of the written field merges", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(() => shown.push(copy.root?.note ?? ''));
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      expect(copy.root).toMatchObject({ name: 'initial', note: 'initial!' });

      const second = copy.edit(root => ({ ...root, note: `${root.note}?` }));
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'merged' }]);
      await tick();
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'initial!?' });
      expect(copy.root).toEqual(server.root);
      expect(shown.every(note => note === 'initial!' || note === 'initial!?')).toBe(true);
   });

   it("stops holding another client's update from a server that sends no heldWrites once a request answered with another still out", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'mine' }));
      const saved = new Deferred<void>();
      server.saveGate = saved.promise;
      const first = copy.save();
      await waitFor(() => server.saved === server.version);
      await server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.clock.pendingTimers() > 0);

      // Gated on the version before the update, it conflicts at once, and
      // its read answers with the first save still out.
      const second = copy.save();
      await waitFor(() => server.saved === server.version);

      expect({ note: copy.root?.note, timers: copy.clock.pendingTimers() }).toEqual({ note: 'theirs', timers: 0 });
      saved.resolve();
      await first;
      await second;
   });

   it("holds another client's update from a server that sends no heldWrites while its write is unanswered, and shows it once the write fails", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
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

   it("shows another client's update from a server that sends no heldWrites once its write has not answered within its bound", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
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

   it("stops the timer of another client's held update from a server that sends no heldWrites once disposed", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
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

   it('holds the document a restore read from a server that sends no heldWrites while a write is out, and shows it once the write answers', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      harness.restart({ name: 'down' }).reportsWrites = false;
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

   it("writes an edit made once another client's update from a server that sends no heldWrites was shown at its bound, over the landed write once", async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      copy.clock.advance(1_000);
      expect(copy.root?.name).toBe('theirs');

      const second = copy.edit(root => ({ ...root, name: 'second' }));
      answered.resolve();
      await Promise.all([first, second]);
      await tick();

      expect(server.root).toEqual({ $type: 'TypeOne', name: 'second', note: 'initial!' });
      expect(copy.root).toEqual(server.root);
   });

   it('leaves its own echo from a server that sends no heldWrites past the bound, so an edit that is not idempotent shows once', async () => {
      const { server, session, events } = makeCopyHarness();
      server.reportsWrites = false;
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      await tick();

      copy.clock.advance(1_000);

      expect(copy.root?.note).toBe('initial!');
      answered.resolve();
      expect(await written).toEqual({ status: 'applied' });
      expect(copy.root?.note).toBe('initial!');
   });

   it('shows the change when a document with the model it showed before its write now holds that write', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(() => shown.push(copy.root?.note ?? ''));
      // As a server that sends only its latest build, so the echo of the write never comes.
      const push = server.push.bind(server);
      server.push = (document, sourceClientId) =>
         sourceClientId === session.clientId ? Promise.resolve() : push(document, sourceClientId);
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);

      await server.foreignWrite({ note: 'initial' });
      await heard;

      expect(copy.root?.note).toBe('initial');
      expect(shown).toEqual(['initial!', 'initial']);
      answered.resolve();
      expect(await written).toEqual({ status: 'applied' });
   });

   it.each(['restarts', 'drops the connection'] as const)(
      'shows an edit that is not idempotent once when the server %s as a conflict of its write starts to reread',
      async how => {
         const harness = makeCopyHarness();
         const copy = new HeldCopy(harness.session, harness.events, URI_A);
         await copy.open();
         const sampled: string[] = [];
         const sample = (): void => void Promise.resolve().then(() => sampled.push(copy.root?.note ?? ''));
         harness.events.onDidUpdateDocument(sample);
         harness.session.onDidRestoreDocument(sample);
         copy.onDidChange(sample);
         const server = harness.server;
         expect(await copy.edit(root => ({ ...root, name: 'earlier' }))).toEqual({ status: 'applied' });
         const gate = new Deferred<void>();
         server.updateGate = gate.promise;
         const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
         await waitFor(() => server.updates === 2);
         await server.foreignWrite({ note: 'conflicting' });
         // The conflict's reread is the first call to wait for the connection, so it waits out the restore.
         let serving: ProbeServer | undefined;
         const connected = harness.session.connected.bind(harness.session);
         harness.session.connected = () => {
            serving ??= how === 'restarts' ? harness.restart() : harness.reconnect();
            return connected();
         };

         gate.resolve();

         expect(await written).toEqual({ status: 'conflict' });
         await tick();
         expect(sampled.filter(note => (note.match(/!/g)?.length ?? 0) > 1)).toEqual([]);
         expect(copy.root).toEqual(serving?.root);
      }
   );

   it('keeps showing its write out while a restore during the conflict reread writes an earlier edit again above its number', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const sampled: string[] = [];
      expect(await copy.edit(root => ({ ...root, name: 'earlier' }))).toEqual({ status: 'applied' });
      harness.events.onDidUpdateDocument(() => void Promise.resolve().then(() => sampled.push(copy.root?.note ?? '')));
      // Refused without another client's write, so the session keeps the earlier edit to restore.
      harness.server.failNext = new ConflictError(URI_A, asModelVersion(1), asModelVersion(2));
      // Restarted without the earlier edit, as the conflict's reread waits for the connection.
      const first = harness.server;
      let serving: ProbeServer | undefined;
      const connected = harness.session.connected.bind(harness.session);
      harness.session.connected = () => {
         if (first.updates === 2) {
            serving ??= harness.restart({ name: 'initial', note: 'initial' });
         }
         return connected();
      };

      await copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await tick();

      expect(serving?.updates).toBeGreaterThanOrEqual(1);
      expect(sampled.filter(note => note !== 'initial!')).toEqual([]);
      expect(copy.root).toEqual(serving?.root);
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

   it("writes a whole-root edit of an item onto that item once another client's insert moved it during the write", async () => {
      const { server, session, events } = makeCopyHarness();
      server.root = { ...server.root, items: [{ id: 'b', label: 'b' }] };
      const copy = new HeldCopy(session, events, URI_A, { itemKey });
      await copy.open();
      const before = copy.root!;
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const edited = copy.editRoot(before, { ...before, items: [{ id: 'b', label: 'ours' }] });
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ items: [{ id: 'a', label: 'a' }, ...before.items!] });
      server.updateGate = undefined;
      answered.resolve();

      expect(await edited).toEqual({ status: 'merged' });
      expect(server.root.items).toEqual([
         { id: 'a', label: 'a' },
         { id: 'b', label: 'ours' }
      ]);
      expect(copy.root).toEqual(server.root);
   });

   it("writes a whole-root edit of an item onto that item when the edit was made before another client's insert moved it", async () => {
      const { server, session, events } = makeCopyHarness();
      server.root = { ...server.root, items: [{ id: 'b', label: 'b' }] };
      const copy = new HeldCopy(session, events, URI_A, { itemKey });
      await copy.open();
      const before = copy.root!;
      await server.foreignWrite({ items: [{ id: 'a', label: 'a' }, ...before.items!] });
      await waitFor(() => copy.root?.items?.length === 2);

      expect(await copy.editRoot(before, { ...before, items: [{ id: 'b', label: 'ours' }] })).toEqual({ status: 'applied' });
      expect(server.root.items).toEqual([
         { id: 'a', label: 'a' },
         { id: 'b', label: 'ours' }
      ]);
      expect(copy.root).toEqual(server.root);
   });

   it("writes a whole-root edit made during a write whose edit of an item another client's edit dropped, when it edits another item", async () => {
      const { server, session, events } = makeCopyHarness();
      server.root = {
         ...server.root,
         items: [
            { id: 'a', label: 'a' },
            { id: 'b', label: 'b' }
         ]
      };
      const copy = new HeldCopy(session, events, URI_A, { itemKey });
      await copy.open();
      const opened = copy.root!;
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const first = copy.editRoot(opened, { ...opened, items: [opened.items![0], { id: 'b', label: 'ours' }] });
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ items: [opened.items![0], { id: 'b', label: 'theirs' }] });

      const shown = copy.root!;
      const second = copy.editRoot(shown, { ...shown, items: [shown.items![1]] });
      server.updateGate = undefined;
      answered.resolve();

      expect(await first).toEqual({ status: 'conflict' });
      expect(await second).toEqual({ status: 'merged' });
      expect(server.root.items).toEqual([{ id: 'b', label: 'theirs' }]);
      expect(copy.root).toEqual(server.root);
   });

   it("reports a conflict for a whole-root edit made during a write that reverts an item another client's edit dropped the write's edit of, past its insert", async () => {
      const [a, b] = [
         { id: 'a', label: 'a' },
         { id: 'b', label: 'b' }
      ];
      const { server, copy, first, release } = await keyedDrop(
         [a, b],
         [a, { id: 'b', label: 'ours' }],
         [a, { id: 'x', label: 'x' }, { id: 'b', label: 'theirs' }]
      );

      const shown = copy.root!;
      const second = copy.editRoot(shown, { ...shown, items: shown.items!.map(item => (item.id === 'b' ? b : item)) });
      release();

      expect([await first, await second]).toEqual([{ status: 'conflict' }, { status: 'conflict' }]);
      expect(server.root.items).toEqual([a, { id: 'x', label: 'x' }, { id: 'b', label: 'theirs' }]);
      expect(copy.root).toEqual(server.root);
   });

   it("reports a conflict for a whole-root edit made during a write that edits an item another client's edit dropped the write's edit of, and adds an item without a key", async () => {
      const a = { id: 'a', label: 'a' };
      const { server, copy, first, release } = await keyedDrop(
         [a, { id: 'b', label: 'b' }],
         [a, { id: 'b', label: 'ours' }],
         [a, { id: 'b', label: 'theirs' }]
      );

      const shown = copy.root!;
      const second = copy.editRoot(shown, { ...shown, items: [a, { id: 'b', label: 'mine' }, { label: 'n' }] });
      release();

      expect([await first, await second]).toEqual([{ status: 'conflict' }, { status: 'conflict' }]);
      expect(server.root.items).toEqual([a, { id: 'b', label: 'theirs' }]);
      expect(copy.root).toEqual(server.root);
   });

   it("reports a conflict for a whole-root edit made during a write that reorders items another client's reorder dropped the write's reorder of", async () => {
      const [a, b, c] = [
         { id: 'a', label: 'a' },
         { id: 'b', label: 'b' },
         { id: 'c', label: 'c' }
      ];
      const { server, copy, first, release } = await keyedDrop([a, b, c], [c, a, b], [b, a, c]);

      const shown = copy.root!;
      const second = copy.editRoot(shown, { ...shown, items: [a, b, c] });
      release();

      expect([await first, await second]).toEqual([{ status: 'conflict' }, { status: 'conflict' }]);
      expect(server.root.items).toEqual([b, a, c]);
      expect(copy.root).toEqual(server.root);
   });

   it("writes the whole-root edit of a batch onto its item once another client's insert moved it, dropping only the batch's edit that collided", async () => {
      const { server, session, events } = makeCopyHarness();
      const [a, b] = [
         { id: 'a', label: 'a' },
         { id: 'b', label: 'b' }
      ];
      server.root = { ...server.root, items: [a, b] };
      const copy = new HeldCopy(session, events, URI_A, { itemKey });
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const sent = copy.edit(root => ({ ...root, note: 'sent' }));
      await waitFor(() => server.updates === 1);
      const shown = copy.root!;
      const colliding = copy.editRoot(shown, { ...shown, items: [a, { id: 'b', label: 'ours' }] });
      const moved = copy.editRoot(shown, { ...shown, items: [{ id: 'a', label: 'ours' }, b] });
      await server.foreignWrite({ items: [{ id: 'x', label: 'x' }, a, { id: 'b', label: 'theirs' }] });
      server.updateGate = undefined;
      answered.resolve();

      expect([await sent, await colliding, await moved]).toEqual([{ status: 'merged' }, { status: 'conflict' }, { status: 'merged' }]);
      expect(server.root.items).toEqual([
         { id: 'x', label: 'x' },
         { id: 'a', label: 'ours' },
         { id: 'b', label: 'theirs' }
      ]);
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

      expect([await first, await second]).toEqual([{ status: 'ran-out' }, { status: 'applied' }]);
      expect(server.root.name).toBe('initial');
   });

   it("reports a conflict for a write another client's edit of its field beat on the only write allowed, and for an edit of that field made during it", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new OneWriteCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });

      const retyped = copy.edit(root => ({ ...root, name: 'retyped' }));
      server.updateGate = undefined;
      answered.resolve();

      expect([await name, await retyped]).toEqual([{ status: 'conflict' }, { status: 'conflict' }]);
      expect(server.root.name).toBe('theirs');
   });

   it.each([
      [
         'the field it wrote, which conflicts',
         { name: 'theirs' },
         ['conflict', 'merged'],
         { $type: 'TypeOne', name: 'theirs', note: 'mine' }
      ],
      ['another field, which runs out', { note: 'theirs' }, ['ran-out', 'conflict'], { $type: 'TypeOne', name: 'initial', note: 'theirs' }]
   ] as const)(
      'reconciles an edit queued behind a write a foreign edit dropped, of %s, though it may send one write',
      async (_raced, foreign, statuses, root) => {
         const { server, session, events } = makeCopyHarness();
         const copy = new OneWriteCopy(session, events, URI_A);
         await copy.open();
         const answered = new Deferred<void>();
         server.updateGate = answered.promise;
         const name = copy.edit(current => ({ ...current, name: 'ours' }));
         await waitFor(() => server.updates === 1);
         await server.foreignWrite(foreign);

         const note = copy.edit(current => ({ ...current, note: 'mine' }));
         server.updateGate = undefined;
         answered.resolve();

         expect({ outcomes: [await name, await note], root: server.root }).toEqual({
            outcomes: statuses.map(status => ({ status })),
            root
         });
      }
   );

   it('writes an edit of a field whose write ran out, made during that write, when no other client changed that field', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new OneWriteCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ note: 'theirs' });

      const retyped = copy.edit(root => ({ ...root, name: 'retyped' }));
      server.updateGate = undefined;
      answered.resolve();

      expect({ outcomes: [await name, await retyped], root: server.root }).toEqual({
         outcomes: [{ status: 'ran-out' }, { status: 'merged' }],
         root: { $type: 'TypeOne', name: 'retyped', note: 'theirs' }
      });
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

   it("writes an edit of a dropped field made once the split write's echo shows another client's value, before the batch answers", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const name = copy.edit(root => ({ ...root, name: 'ours' }));
      const note = copy.edit(root => ({ ...root, note: 'unrelated' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      const split = new Deferred<void>();
      server.answerGate = split.promise;
      server.updateGate = undefined;
      answered.resolve();
      await waitFor(() => server.root.note === 'unrelated');
      await tick();
      expect(copy.root).toMatchObject({ name: 'theirs', note: 'unrelated' });

      const retyped = copy.edit(root => ({ ...root, name: 'retyped' }));
      server.answerGate = undefined;
      split.resolve();

      expect([await name, await note, await retyped]).toEqual([{ status: 'conflict' }, { status: 'merged' }, { status: 'applied' }]);
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'retyped', note: 'unrelated' });
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
      // Made before the other client's update arrives.
      const pushed = server.foreignWrite({ note: 'theirs' });
      const second = copy.edit(root => ({ ...root, note: 'ours' }));
      await pushed;

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
      // Made before the other client's update arrives.
      const pushed = server.foreignWrite({ note: 'theirs' });
      const second = copy.edit(root => ({ ...root, name: 'again' }));
      await pushed;

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

   it("saves again once it has shown another client's text its save conflicted with", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const shown: { note?: string; saved: number }[] = [];
      copy.onDidChange(() => shown.push({ note: copy.root?.note, saved: server.saved }));

      const saved = await copy.save();

      expect(saved?.persisted).toEqual({ version: 3 });
      expect(shown).toEqual([{ note: 'theirs', saved: 1 }]);
      expect({ saved: server.saved, dirty: copy.dirty }).toEqual({ saved: 3, dirty: false });
   });

   it('rejects a save that conflicts again with a write not pushed during its read', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const reads = server.reads;
      const saving = copy.save();
      await waitFor(() => server.reads === reads + 1);
      server.unpushedWrite({ note: 'later' });

      read.resolve();

      await expect(saving).rejects.toBeInstanceOf(ConflictError);
      expect({ reads: server.reads - reads, saved: server.saved, dirty: copy.dirty }).toEqual({ reads: 1, saved: 1, dirty: true });
   });

   it('saves the write another client pushed during its read after a conflict', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const reads = server.reads;
      const saving = copy.save();
      await waitFor(() => server.reads === reads + 1);
      await server.foreignWrite({ note: 'later' });
      await waitFor(() => copy.root?.note === 'later');

      read.resolve();

      await saving;
      expect({ saved: server.saved, note: copy.root?.note, dirty: copy.dirty }).toEqual({
         saved: server.version,
         note: 'later',
         dirty: false
      });
   });

   it('rejects with the conflict a save whose read after it fails', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      server.failRead = new Error('read refused');
      const reads = server.reads;

      await expect(copy.save()).rejects.toBeInstanceOf(ConflictError);

      expect({ reads: server.reads - reads, saved: server.saved, note: copy.root?.note, dirty: copy.dirty }).toEqual({
         reads: 1,
         saved: 1,
         note: 'initial',
         dirty: true
      });
   });

   it('fails a save whose read after a conflict finds the file gone', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      server.missing = true;

      await expect(copy.save()).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect({ saved: server.saved, snapshot: copy.snapshot }).toEqual({ saved: 1, snapshot: undefined });
   });

   it('does not read again after a save that fails other than by a conflict', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      // Ended on the server without an event, so the persist is refused.
      server.opens.clear();
      const reads = server.reads;

      await expect(copy.save()).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect({ reads: server.reads - reads, saved: server.saved }).toEqual({ reads: 0, saved: 1 });
   });

   it('writes an edit made during the read after a conflict before it saves again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const reads = server.reads;
      const saving = copy.save();
      await waitFor(() => server.reads === reads + 1);
      server.readGate = undefined;
      const written = copy.edit(root => ({ ...root, name: 'later' }));

      read.resolve();

      // Made on the text before the read, its write conflicts and merges.
      expect(await written).toEqual({ status: 'merged' });
      await saving;
      expect(server.saved).toBe(server.version);
      expect(server.root).toMatchObject({ name: 'later', note: 'theirs' });
   });

   it('does not save the text a read after a conflict brings once the copy is disposed, as it is not announced', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const reads = server.reads;
      const saving = copy.save();
      await waitFor(() => server.reads === reads + 1);
      copy.dispose();

      read.resolve();

      await expect(saving).rejects.toThrow('WorkingCopy is disposed');
      expect(server.saved).toBe(1);
   });

   it('does not save the text another client pushed once the copy is disposed while the save waits for its edits', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const gate = new Deferred<void>();
      server.updateGate = gate.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      const saving = copy.save();
      copy.dispose();
      await server.foreignWrite({ note: 'theirs' });
      server.updateGate = undefined;

      gate.resolve();

      await written;
      await expect(saving).rejects.toThrow('WorkingCopy is disposed');
      expect(server.saved).toBe(1);
   });

   it.each([
      ['deleted', (_copy: HeldCopy, server: ProbeServer) => server.deleteFile()],
      ['closed', (copy: HeldCopy) => copy.close()]
   ] as const)('fails a save whose document was %s during the read after a conflict', async (_case, end) => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const read = new Deferred<void>();
      server.readGate = read.promise;
      const reads = server.reads;
      const saving = copy.save();
      await waitFor(() => server.reads === reads + 1);
      await end(copy, server);
      await waitFor(() => copy.snapshot === undefined);

      read.resolve();

      await expect(saving).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(server.saved).toBe(1);
   });

   it.each([
      ['the first', () => false, 0],
      [
         "the second, once it shows another client's text",
         (snapshot: TransferDocument<ProbeElement>) => snapshot.model?.root.note !== 'theirs',
         1
      ]
   ] as const)('refuses %s save its host declines and stays dirty', async (_case, allowed, rereads) => {
      const { server, session, events } = makeCopyHarness();
      const copy = new (class extends HeldCopy {
         protected override canPersist(snapshot: TransferDocument<ProbeElement>): boolean {
            return allowed(snapshot);
         }
      })(session, events, URI_A);
      await copy.open();
      await copy.edit(root => ({ ...root, name: 'ours' }));
      server.unpushedWrite({ note: 'theirs' });
      const reads = server.reads;

      await expect(copy.save()).rejects.toBeInstanceOf(SaveFailedError);

      expect({ reads: server.reads - reads, saved: server.saved, dirty: copy.dirty }).toEqual({ reads: rereads, saved: 1, dirty: true });
   });

   it.each([
      ['a same-field conflict', HeldCopy, { name: 'theirs' }, 'conflict'],
      ['running out of writes', OneWriteCopy, { note: 'theirs' }, 'ran-out'],
      ['running out of writes under a resolver that reads nothing', ForceOneWriteCopy, { note: 'theirs' }, 'ran-out']
   ] as const)("shows the server's diagnostics once %s dropped the edit, read once", async (_case, Copy, foreign, status) => {
      const { server, session, events } = makeCopyHarness();
      const copy = new Copy(session, events, URI_A);
      await copy.open();
      const readsBefore = server.reads;
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite(foreign);
      // Only the read after the conflict carries them.
      server.problems = [PROBLEM];
      answered.resolve();

      expect(await written).toEqual({ status });
      expect({ diagnostics: copy.diagnostics, reads: server.reads - readsBefore }).toEqual({ diagnostics: [PROBLEM], reads: 1 });
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

      expect(copy.root?.name).toBe('theirs');
      const second = copy.edit(root => ({ ...root, note: 'second' }));
      answered.resolve();

      expect(await first).toEqual({ status: 'applied' });
      // Made on the other client's edit, shown with the write it holds.
      expect(await second).toEqual({ status: 'applied' });
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

   it("shows another client's update at once while its write has not landed", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const landed = new Deferred<void>();
      server.updateGate = landed.promise;
      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.updates === 1);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;

      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'initial!' });
      landed.resolve();

      expect(await written).toEqual({ status: 'merged' });
      expect(copy.root).toEqual(server.root);
   });

   it("shows another client's update at once over its landed write whose answer is out, with an edit that is not idempotent once", async () => {
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

      expect(copy.root).toEqual({ $type: 'TypeOne', name: 'theirs', note: 'initial!' });
      answered.resolve();

      expect(await written).toEqual({ status: 'applied' });
      expect(copy.root).toEqual(server.root);
   });

   it('writes an edit made on a document that holds the write still out without reading the document again', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      const first = copy.edit(root => ({ ...root, note: `${root.note}!` }));
      await waitFor(() => server.version === 2);
      const heard = nextUpdate(events);
      await server.foreignWrite({ name: 'theirs' });
      await heard;
      const reads = server.reads;

      const second = copy.edit(root => ({ ...root, name: `${root.name}?` }));
      answered.resolve();

      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect({ reads: server.reads, root: server.root }).toEqual({ reads, root: { $type: 'TypeOne', name: 'theirs?', note: 'initial!' } });
      expect(copy.root).toEqual(server.root);
   });

   it('fails an open whose read failed, and opens it again', async () => {
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

   it('takes an edit made while an edit out throws on the root shown', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const landed = new Deferred<void>();
      server.updateGate = landed.promise;
      const first = copy.edit(root => {
         if (root.name === 'theirs') {
            throw new TypeError('renamed');
         }
         return { ...root, note: 'first' };
      });
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ name: 'theirs' });
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');
      expect(() => copy.root).toThrow('renamed');

      const second = copy.edit(root => ({ ...root, name: 'second' }));
      landed.resolve();

      expect([await first, await second]).toEqual([{ status: 'merged' }, { status: 'merged' }]);
      expect(server.root).toMatchObject({ name: 'second', note: 'first' });
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

   it('applies an edit of another field queued behind a write the server normalized', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const change = server['change'].bind(server);
      server['change'] = (root, clientId) => change({ ...root, name: root.name.trim() }, clientId);
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      const first = copy.edit(root => ({ ...root, name: 'first ' }));
      await waitFor(() => server.updates === 1);
      const second = copy.edit(root => ({ ...root, note: 'ours' }));
      answer.resolve();

      expect({ first: await first, second: await second }).toEqual({ first: { status: 'applied' }, second: { status: 'applied' } });
      expect(server.root).toMatchObject({ name: 'first', note: 'ours' });
   });

   it("applies an edit queued behind a write whose answer holds another client's change of text the model does not show", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const answer = new Deferred<void>();
      server.answerGate = answer.promise;
      server.answerLatest = true;
      const first = copy.edit(root => ({ ...root, name: 'first' }));
      await waitFor(() => server.updates === 1);
      const second = copy.edit(root => ({ ...root, note: 'ours' }));
      // A comment another client adds: a new version with the same model.
      server.version++;
      await server.push(server['document'](), OTHER_CLIENT);
      answer.resolve();

      expect({ first: await first, second: await second, updates: server.updates }).toEqual({
         first: { status: 'applied' },
         second: { status: 'applied' },
         updates: 2
      });
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
      await waitFor(() => copy.snapshot?.model?.root.name === 'theirs');

      const second = copy.edit(root => ({ ...root, name: 'mine' }));
      answer.resolve();

      expect(await first).toEqual({ status: 'applied' });
      await second;
      expect(server.root).toEqual({ $type: 'TypeOne', name: 'mine', note: 'initial!' });
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

   it.each([
      ['', OneWriteCopy],
      [' under a resolver that reads nothing', ForceOneWriteCopy]
   ] as const)('rejects an edit whose only write conflicted when it could not read the document again%s', async (_case, Copy) => {
      const { server, session, events } = makeCopyHarness();
      const copy = new Copy(session, events, URI_A);
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

      await expect(written).rejects.toThrow('read failed');
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

   it('fails an open that finds the file gone, and opens it again', async () => {
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

   it('reports unavailable and drops the document when the read after its only write conflicted finds it gone', async () => {
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

      expect(await written).toEqual({ status: 'unavailable' });
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

   it('is clean once its server restarted clean while a write was out that then failed', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      for (const name of ['one', 'two', 'three']) {
         const written = copy.edit(root => ({ ...root, name }));
         await written;
      }

      const restored = nextRestore(harness.session);
      const restarted = harness.restart();
      restarted.failNext = new Error('refused');
      const written = copy.edit(root => ({ ...root, note: 'refused' }));
      await expect(written).rejects.toThrow('refused');
      await restored;

      expect(copy.dirty).toBe(false);
   });

   it('keeps a change made while its server was down under an edit queued before', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const written = copy.edit(root => ({ ...root, name: 'ours' }));

      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ note: 'external' });
      await restored;
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

      const heard = nextUpdate(events, session.clientId);
      await server.push(echo ?? TransferDocument.absent<ProbeElement>(URI_A, server.epoch), session.clientId);
      await heard;

      expect(copy.root?.name).toBe('second');
   });

   it('keeps its write when a push with an older model but newer text arrives while the write is out', async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const before = copy.snapshot ?? TransferDocument.absent<ProbeElement>(URI_A, server.epoch);
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

   it('saves a change made while its server was down only once it has shown it', async () => {
      const harness = makeCopyHarness();
      harness.server.saved = 0;
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      expect(copy.dirty).toBe(true);
      const shown: { note?: string; saved: number }[] = [];

      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ note: 'external' });
      restarted.saved = 0;
      copy.onDidChange(() => shown.push({ note: copy.root?.note, saved: restarted.saved }));
      const saved = copy.save();

      await saved;
      expect(shown.find(entry => entry.note === 'external')).toEqual({ note: 'external', saved: 0 });
      expect(restarted.saved).toBe(restarted.version);
      await restored;
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

   it.each([
      ['a document', false, 'conflict'],
      ['no document', true, 'unavailable']
   ] as const)(
      'shows the document of the restarted server over a conflict read of %s before the restart that answers after it',
      async (_name, missing, status) => {
         const harness = makeCopyHarness();
         const copy = new HeldResolverCopy(harness.session, harness.events, 1);
         await copy.open();
         const name = copy.edit(root => ({ ...root, name: 'ours' }));
         await harness.server.foreignWrite({ name: 'theirs' });
         harness.server.missing = missing;
         await copy.resolver.held.promise;

         const restored = new Deferred<void>();
         harness.session.onDidRestoreDocument(() => restored.resolve());
         const restarted = harness.restart({ note: 'external' });
         await restored.promise;
         // The reread of the restore answers first, and is held behind the write.
         await waitFor(() => restarted.reads >= 1);
         await tick();
         copy.resolver.merge.resolve();

         expect(await name).toEqual({ status });
         await waitFor(() => copy.snapshot?.epoch === restarted.epoch, {
            message: 'The copy does not show the document of the restarted server'
         });
         expect(copy.snapshot?.model?.root).toMatchObject({ name: 'theirs', note: 'external' });
      }
   );

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

   it('opens in one read with the diagnostics', async () => {
      const { server, session, events } = makeCopyHarness();
      server.problems = [PROBLEM];
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      expect({ reads: server.reads, diagnostics: copy.diagnostics }).toEqual({ reads: 1, diagnostics: [PROBLEM] });
   });

   it('takes a change and a save another client made right after its open answered', async () => {
      const { server, session, events } = makeCopyHarness();
      server.afterWatchedOpen = async () => {
         await server.foreignWrite({ note: 'theirs' });
         await server.foreignSave();
      };
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      await waitFor(() => copy.root?.note === 'theirs' && !copy.dirty, { message: 'the copy missed the change after its open' });
      expect(server.reads).toBe(1);
   });

   it('reads again after its open on a server that ignores watch, taking a change made before the watch was placed', async () => {
      const { server, session, events } = makeCopyHarness();
      server.ignoresWatch = true;
      // Not watched yet, so the client hears nothing of it.
      server.beforeWatch = () => {
         server.root = { ...server.root, note: 'unheard' };
         server.version++;
      };
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();

      await waitFor(() => copy.root?.note === 'unheard', { message: 'the copy kept the answer from before the watch' });
   });

   it.each([
      ['restores with diagnostics', true],
      ['restores without them, as the restarted server validated it already', false]
   ])('takes the diagnostics of the restored document without reading it again when its session %s', async (_how, withDiagnostics) => {
      const harness = makeCopyHarness(undefined, withDiagnostics);
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ note: 'external' });
      restarted.problems = [PROBLEM];

      await restored;
      await tick(20);
      expect({ note: copy.root?.note, diagnostics: copy.diagnostics, reads: restarted.reads }).toEqual({
         note: 'external',
         diagnostics: [PROBLEM],
         reads: 1
      });
   });

   it('keeps a change heard while the restore read the document over the older document the read answers', async () => {
      const harness = makeCopyHarness(undefined, true);
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ note: 'external' });
      restarted.problems = [PROBLEM];
      const reopening = new Deferred<void>();
      restarted.readGate = reopening.promise;
      await waitFor(() => restarted.reads === 1, { message: 'the restore never re-opened the document' });
      // Changed while the re-open is out, so the restore reads it again, and
      // that read answers only after a later change was sent.
      await restarted.foreignWrite({ note: 'during' });
      const reading = new Deferred<void>();
      restarted.readGate = reading.promise;
      reopening.resolve();
      await waitFor(() => restarted.reads === 2, { message: 'the restore never read the document again' });
      await restarted.foreignWrite({ note: 'newer' });
      await waitFor(() => copy.root?.note === 'newer', { message: 'the copy never took the later change' });
      reading.resolve();

      await restored;
      await waitFor(() => restarted.reads === 3, { message: 'the copy never read the document again' });
      await tick(20);
      expect(copy.root?.note).toBe('newer');
   });

   it('keeps its diagnostics until it read them again after a restore without them', async () => {
      const harness = makeCopyHarness();
      harness.server.problems = [PROBLEM];
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ note: 'external' });
      // Not validated yet, so the restore's read answers no diagnostics.
      restarted.validated = false;

      // Heard after the copy took the restored document.
      await restored;
      expect({ note: copy.root?.note, diagnostics: copy.diagnostics }).toEqual({ note: 'external', diagnostics: [PROBLEM] });
      await waitFor(() => copy.diagnostics.length === 0, { message: 'the copy never took the diagnostics of its reread' });
      expect(restarted.reads).toBe(2);
   });

   it('fails an open whose server restarts while it is out, and opens it again', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      harness.server.openGate = new Deferred<void>().promise;
      const opened = copy.open();
      await tick(20);
      const restarted = harness.restart({ note: 'external' });

      await expect(opened).rejects.toBeInstanceOf(ResponseError);
      expect(copy.snapshot).toBeUndefined();
      await copy.open();
      expect({ note: copy.root?.note, opens: restarted.opens.size }).toEqual({ note: 'external', opens: 1 });
   });

   it('lets a session that re-sends an open its connection dropped open the copy on the restarted server', async () => {
      const harness = makeCopyHarness();
      const send = harness.session.openDocument.bind(harness.session);
      harness.session.openDocument = async args => {
         try {
            return await send(args);
         } catch (error: unknown) {
            if (!(error instanceof ResponseError && error.code === ErrorCodes.PendingResponseRejected)) {
               throw error;
            }
            await harness.session.connected();
            return send(args);
         }
      };
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      harness.server.openGate = new Deferred<void>().promise;
      const opened = copy.open();
      await tick(20);
      const restarted = harness.restart({ note: 'external' });

      await opened;
      expect({ note: copy.root?.note, opens: restarted.opens.size }).toEqual({ note: 'external', opens: 1 });
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

   it("announces another client's value once a batch that changes nothing leaves the root", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(event => shown.push(`${event.reason}:${copy.root?.name}`));
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, note: 'one' }));
      await waitFor(() => server.updates === 1);
      const same = copy.edit(root => ({ ...root, name: 'initial' }));
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });

      held.resolve();

      expect([await first, await same]).toEqual([{ status: 'merged' }, { status: 'unchanged' }]);
      expect(shown.at(-1)).toBe('changed:theirs');
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

   it("writes an edit that restates a value a conflict dropped once the copy shows the other client's value", async () => {
      const { server, session, events } = makeCopyHarness();
      const copy = new HeldCopy(session, events, URI_A);
      await copy.open();
      const held = new Deferred<void>();
      server.updateGate = held.promise;
      const first = copy.edit(root => ({ ...root, name: 'x' }));
      await waitFor(() => server.updates === 1);
      const other = copy.edit(root => ({ ...root, note: 'n' }));
      server.updateGate = undefined;
      await server.foreignWrite({ name: 'theirs' });
      const answered = new Deferred<void>();
      server.answerGate = answered.promise;
      held.resolve();
      await waitFor(() => server.root.note === 'n');
      await tick();
      expect(copy.root?.name).toBe('theirs');

      const again = copy.edit(root => ({ ...root, name: 'x' }));
      server.answerGate = undefined;
      answered.resolve();

      expect([await first, await other, await again]).toEqual([{ status: 'conflict' }, { status: 'merged' }, { status: 'applied' }]);
      expect(server.root).toMatchObject({ name: 'x', note: 'n' });
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

   it('shows the document a restore read while a write is out, and the write merged over it once it answers', async () => {
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

      expect(shown).toBe('down');
      expect(await written).toEqual({ status: 'merged' });
      expect(copy.root).toMatchObject({ name: 'down', note: 'mine' });
   });

   it('shows an edit typed while the connection is down over a restore that wrote an earlier edit again under a later number', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      expect(await copy.edit(root => ({ ...root, name: 'first' }))).toEqual({ status: 'applied' });
      let shown: ProbeElement | undefined;
      harness.session.onDidRestoreDocument(() => {
         shown = copy.root;
      });

      // Restarted without the first edit, so the restore writes it again.
      harness.restart({ name: 'initial' });
      const second = copy.edit(root => ({ ...root, note: 'second' }));
      await waitFor(() => shown !== undefined);

      expect(shown).toMatchObject({ name: 'first', note: 'second' });
      expect(await second).toEqual({ status: 'applied' });
   });

   it('shows an edit that is not idempotent once when typed while the connection to the same server is down', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const shown: string[] = [];
      copy.onDidChange(() => shown.push(copy.root?.note ?? ''));
      const server = harness.reconnect();

      const written = copy.edit(root => ({ ...root, note: `${root.note}!` }));

      expect(await written).toEqual({ status: 'applied' });
      await tick();
      expect(shown.filter(note => note !== 'initial!')).toEqual([]);
      expect(server.root.note).toBe('initial!');
   });

   it('applies an edit typed while the connection is down to a server that restarted with the text unchanged', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restarted = harness.restart();

      expect(await typeWhileDown(copy)).toEqual({ status: 'applied' });
      expect(restarted.root.name).toBe('typed');
   });

   it('applies an edit after a reconnect that found the text another client wrote at its version', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      await harness.server.foreignWrite({ note: 'theirs' });
      await waitFor(() => copy.version === 2);
      const restarted = harness.restart();
      restarted.version = 2;

      expect(await copy.edit(root => ({ ...root, name: 'mine' }))).toEqual({ status: 'applied' });
      expect(restarted.root).toMatchObject({ name: 'mine', note: 'theirs' });
   });

   it('reconciles an edit on the base from before a restart, which the restarted server refuses, and reports it applied', async () => {
      const harness = makeCopyHarness();
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restarted = harness.restart();
      restarted.modelOffset = 1;

      expect(await typeWhileDown(copy)).toEqual({ status: 'applied' });
      // The typed edit's refused write and its reconciled one.
      expect(restarted.updates).toBe(2);
      expect(restarted.root.name).toBe('typed');
   });

   it("shows the server's diagnostics once its writes ran out under a resolver that read only before an earlier write", async () => {
      const { server, session, events } = makeCopyHarness();
      // Reads on its first conflict only, then another writer lands before the next write.
      class ReadsFirst extends ReconcilingConflictResolver {
         calls = 0;
         override async resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
            this.calls++;
            if (this.calls > 1) {
               // Only a read after this conflict carries them.
               server.problems = [PROBLEM];
               return { status: 'merged', merged: ours };
            }
            const outcome = await super.resolve(base, ours, refetch);
            await server.foreignWrite({ note: 'second' });
            return outcome;
         }
      }
      class ReadsFirstCopy extends HeldCopy {
         protected override readonly conflictResolver = new ReadsFirst();
         protected override readonly maxWrites = 2;
      }
      const copy = new ReadsFirstCopy(session, events, URI_A);
      await copy.open();
      const answered = new Deferred<void>();
      server.updateGate = answered.promise;
      const written = copy.edit(root => ({ ...root, name: 'ours' }));
      await waitFor(() => server.updates === 1);
      await server.foreignWrite({ note: 'first' });
      answered.resolve();

      expect(await written).toEqual({ status: 'ran-out' });
      expect(copy.diagnostics).toEqual([PROBLEM]);
   });

   it('reports merged for an edit whose write landed past a foreign edit after a reread that found its text unchanged', async () => {
      const harness = makeCopyHarness();
      let race: () => Promise<void> = async () => undefined;
      // Rereads on its first conflict only, and wins the next without one.
      class RereadOnce extends ReconcilingConflictResolver {
         calls = 0;
         override async resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
            this.calls++;
            if (this.calls > 1) {
               return { status: 'merged', merged: ours };
            }
            const outcome = await super.resolve(base, ours, refetch);
            await race();
            return outcome;
         }
      }
      class RereadOnceCopy extends HeldCopy {
         protected override readonly conflictResolver = new RereadOnce();
      }
      const copy = new RereadOnceCopy(harness.session, harness.events, URI_A);
      await copy.open();
      const restarted = harness.restart();
      restarted.modelOffset = 1;
      race = () => restarted.foreignWrite({ note: 'theirs' });

      expect(await typeWhileDown(copy)).toEqual({ status: 'merged' });
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

      const restored = nextRestore(harness.session);
      const restarted = harness.restart({ name: 'theirs' });
      await restored;

      expect(await written).toEqual({ status: 'conflict' });
      expect(restarted.root.name).toBe('theirs');
      expect(copy.root?.name).toBe('theirs');
   });

   it("keeps a save heard while the restore's last read was out", async () => {
      const harness = makeCopyHarness(undefined, true);
      const copy = new HeldCopy(harness.session, harness.events, URI_A);
      try {
         await copy.open();
         const restored = nextRestore(harness.session);
         const restarted = harness.restart({ note: 'external' });
         const reopening = new Deferred<void>();
         restarted.readGate = reopening.promise;
         await waitFor(() => restarted.reads === 1);
         await restarted.foreignWrite({ note: 'during' });
         await waitFor(() => copy.dirty);
         const reading = new Deferred<void>();
         restarted.readGate = reading.promise;
         reopening.resolve();
         await waitFor(() => restarted.reads === 2);
         await restarted.foreignSave();
         await waitFor(() => !copy.dirty);
         reading.resolve();
         await restored;
         await tick(20);
         expect(copy.dirty).toBe(false);
      } finally {
         copy.dispose();
         harness.dispose();
      }
   });
});
