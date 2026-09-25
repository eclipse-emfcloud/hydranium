/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The revert to disk that follows a document's last close, run by the text
 * store for every head. The store is real; the build, the lock and the disk
 * queue it reaches are recording doubles, so what is asserted is WHEN the
 * revert build is dispatched and whether it is at all.
 */

import { createMessagePortTransport, Deferred } from '@hydranium/protocol';
import { makeFakeClock, type FakeClock, waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import { URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { createConnection, type WatchDog } from 'vscode-languageserver';
import {
   createProtocolConnection,
   DidChangeTextDocumentNotification,
   DidOpenTextDocumentNotification,
   type ProtocolConnection
} from 'vscode-languageserver-protocol/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { makeNoopTracer } from '../../src/testing/index.js';

const FILE = URI.file('/hydranium-test/revert.a').toString();
const OTHER_FILE = URI.file('/hydranium-test/other.a').toString();
const DISK = 'on disk\n';
const EDITED = 'edited\n';

/** Shows the ids the store holds as lost, which no behaviour tells apart from pruned ones. */
class InspectableTextDocuments extends HydraniumTextDocuments<TextDocument> {
   lostClientIds(uri: string): string[] {
      return [...(this.__documents.get(this.documentKey(uri))?.lostClients?.keys() ?? [])];
   }
}

interface RevertRig {
   readonly docs: InspectableTextDocuments;
   readonly clock: FakeClock;
   /** Every `DocumentBuilder.update` dispatched under the write lock, with the reason staged for it. */
   readonly builds: Array<{ changed: string[]; deleted?: string[]; reason: string | undefined }>;
   /** The files that exist. */
   readonly onDisk: Set<string>;
   /** How many existence checks the revert has made. */
   readonly existenceChecks: () => number;
   readonly errors: string[];
   /** Hold the disk queue: every task queued until `release()` waits behind it. */
   holdQueue(): { release: () => void };
   /** Hold the write lock, as a build already running does, until `release()`. */
   holdLock(): { release: () => void };
   /** Fail the next `DocumentBuilder.update` with `error`. */
   failNextBuild(error: Error): void;
   /** Step the wall clock (`now()`) by `ms`, as a time sync does, leaving timers and stopwatches alone. */
   jumpWallClock(ms: number): void;
}

/**
 * `workspaceInitialized` stands for the workspace manager's gate, which the
 * store's LSP open handler awaits; it defaults to already settled.
 */
function makeRig(revertGraceMs?: number, workspaceInitialized: Promise<unknown> = Promise.resolve()): RevertRig {
   const clock = makeFakeClock();
   const builds: Array<{ changed: string[]; deleted?: string[]; reason: string | undefined }> = [];
   const errors: string[] = [];
   let staged: string | undefined;
   const uriPolicy = new DefaultDocumentUriPolicy();
   const fileSystemTaskQueue = new DefaultFileSystemTaskQueue({ workspace: { DocumentUriPolicy: uriPolicy } });
   let lockTail: Promise<unknown> = Promise.resolve();
   let nextBuildFailure: Error | undefined;
   const onDisk = new Set<string>([FILE, OTHER_FILE]);
   let existenceChecks = 0;
   let wallOffsetMs = 0;
   const noop = makeNoopTracer();
   const recordError = (message: string): void => {
      errors.push(message);
   };
   // Layered over the no-op tracer rather than spread from it: its methods live
   // on a prototype, which a spread drops.
   const scoped = Object.assign(Object.create(noop.with(FILE)) as object, { error: recordError });
   const tracer: object = Object.assign(Object.create(noop) as object, {
      error: recordError,
      with: () => scoped,
      trace: () => tracer
   });
   const services = {
      Clock: { ...clock, now: () => clock.now() + wallOffsetMs },
      Tracer: { for: () => tracer },
      workspace: {
         DocumentUriPolicy: uriPolicy,
         WorkspaceManager: { ready: Promise.resolve(), workspaceInitialized },
         WorkspaceLock: { write: (action: (token: unknown) => unknown) => lockTail.then(() => action(undefined)) },
         DocumentBuilder: {
            markNextReason: (reason: string | undefined) => {
               staged = reason;
            },
            update: async (changed: URI[], deleted: URI[]) => {
               const failure = nextBuildFailure;
               nextBuildFailure = undefined;
               if (failure) {
                  throw failure;
               }
               builds.push({
                  changed: changed.map(uri => uri.toString()),
                  ...(deleted.length > 0 ? { deleted: deleted.map(uri => uri.toString()) } : {}),
                  reason: staged
               });
               staged = undefined;
            }
         },
         FileSystemProvider: {
            exists: async (uri: URI) => {
               existenceChecks++;
               return onDisk.has(uri.toString());
            }
         },
         FileSystemTaskQueue: fileSystemTaskQueue
      }
   } as unknown as ServerSharedServices;
   const docs = new InspectableTextDocuments(services, { revertGraceMs });
   return {
      docs,
      clock,
      builds,
      errors,
      onDisk,
      existenceChecks: () => existenceChecks,
      holdQueue: () => {
         let release!: () => void;
         const held = new Promise<void>(resolve => (release = resolve));
         void fileSystemTaskQueue.enqueue(FILE, () => held);
         return { release };
      },
      holdLock: () => {
         let release!: () => void;
         const held = new Promise<void>(resolve => (release = resolve));
         lockTail = lockTail.then(() => held);
         return { release };
      },
      failNextBuild: error => {
         nextBuildFailure = error;
      },
      jumpWallClock: ms => {
         wallOffsetMs += ms;
      }
   };
}

function open(docs: HydraniumTextDocuments<TextDocument>, clientId: string, uri = FILE): void {
   docs.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'plaintext', version: 0, text: DISK } }, clientId);
}

function close(docs: HydraniumTextDocuments<TextDocument>, clientId: string, cause?: 'closed' | 'lost', uri = FILE): void {
   docs.notifyDidCloseTextDocument({ textDocument: { uri } }, clientId, cause);
}

/** Let the revert's promise chain run: the disk-queue hop, the ready wait and the locked build. */
async function settle(): Promise<void> {
   for (let i = 0; i < 10; i++) {
      await Promise.resolve();
   }
}

describe('HydraniumTextDocuments — revert on last close', () => {
   it('rebuilds the document from disk once its last client closes it, with no LSP head', async () => {
      const { docs, builds } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form');
      await settle();

      expect(builds).toEqual([{ changed: [FILE], reason: 'didClose' }]);
   });

   it('does not revert while another client still has the document open', async () => {
      const { docs, builds } = makeRig();
      open(docs, 'form');
      open(docs, 'diagram');

      close(docs, 'form');
      await settle();

      expect(builds).toEqual([]);
      expect(docs.get(FILE)).toBeDefined();
   });

   it("waits for the document's disk queue before dispatching the revert", async () => {
      const { docs, builds, holdQueue } = makeRig();
      open(docs, 'form');
      const queued = holdQueue();

      close(docs, 'form');
      await settle();
      expect(builds).toEqual([]);

      queued.release();
      await settle();
      expect(builds).toHaveLength(1);
   });

   it('does not revert a document a client opened again while the queue drained', async () => {
      const { docs, builds, holdQueue } = makeRig();
      open(docs, 'form');
      const queued = holdQueue();

      close(docs, 'form');
      open(docs, 'diagram');
      queued.release();
      await settle();

      expect(builds).toEqual([]);
   });

   it('leaves a document a client re-creates while the revert waits for the write lock', async () => {
      const { docs, builds, onDisk, holdLock } = makeRig();
      onDisk.clear();
      open(docs, 'form');
      const lock = holdLock();

      close(docs, 'form');
      await settle();
      open(docs, 'other');
      lock.release();
      await settle();

      expect(builds).toEqual([]);
      expect(docs.isOpenInClient(FILE, 'other')).toBe(true);
      expect(docs.get(FILE)).toBeDefined();
   });

   it('removes, and logs no error for, a document whose file goes before the rebuild reads it', async () => {
      const { docs, builds, errors, failNextBuild } = makeRig();
      open(docs, 'form');
      failNextBuild(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', path: URI.parse(FILE).fsPath }));

      close(docs, 'form');
      await settle();

      expect(builds).toEqual([{ changed: [], deleted: [FILE], reason: 'didClose' }]);
      expect(errors).toEqual([]);
   });

   it("keeps a document whose rebuild fails on another document's missing file, and logs it", async () => {
      const { docs, builds, errors, failNextBuild } = makeRig();
      open(docs, 'form');
      failNextBuild(
         Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', path: URI.file('/hydranium-test/other.a').fsPath })
      );

      close(docs, 'form');
      await settle();

      expect(builds).toEqual([]);
      expect(errors.some(message => message.includes('ENOENT'))).toBe(true);
   });

   it('reads whether the file exists before it takes the write lock, so no build waits on its disk queue', async () => {
      const { docs, existenceChecks, holdLock } = makeRig();
      open(docs, 'form');
      const lock = holdLock();

      close(docs, 'form');
      await settle();

      expect(existenceChecks()).toBe(1);
      lock.release();
   });

   it('logs no error for a revert that runs after its connection went away', async () => {
      const { docs, errors, failNextBuild } = makeRig();
      open(docs, 'form');
      failNextBuild(new Error('Connection is disposed.'));

      close(docs, 'form');
      await settle();

      expect(errors).toEqual([]);
   });

   it('leaves a document that is not a file alone', async () => {
      const { docs, builds } = makeRig();
      const builtin = 'builtin:///library.a';
      open(docs, 'form', builtin);

      close(docs, 'form', undefined, builtin);
      await settle();

      expect(builds).toEqual([]);
   });

   it('removes a document with no file behind it from the workspace rather than rebuilding it', async () => {
      const { docs, builds, onDisk } = makeRig();
      onDisk.clear();
      open(docs, 'form');

      close(docs, 'form');
      await settle();

      expect(builds).toEqual([{ changed: [], deleted: [FILE], reason: 'didClose' }]);
   });

   it('logs a revert whose queue wait fails', async () => {
      const { docs, errors } = makeRig();
      const services = docs['services'] as unknown as { workspace: { FileSystemTaskQueue: { enqueue: () => Promise<never> } } };
      services.workspace.FileSystemTaskQueue.enqueue = () => Promise.reject(new Error('queue broke'));
      open(docs, 'form');

      close(docs, 'form');
      await settle();

      expect(errors.some(message => message.includes('queue broke'))).toBe(true);
   });

   it('releases the document at once when the grace is 0, even for a lost client', () => {
      const { docs } = makeRig(0);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form', 'lost');

      expect(docs.get(FILE)).toBeUndefined();
      expect(docs.isRevertPending(FILE)).toBe(false);
   });
});

describe('HydraniumTextDocuments — revert grace', () => {
   it('keeps a lost client’s document for 10 s when no grace is configured', async () => {
      const { docs, builds, clock } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form', 'lost');
      clock.advance(9_999);
      await settle();
      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(builds).toEqual([]);

      clock.advance(1);
      await settle();
      expect(docs.get(FILE)).toBeUndefined();
      expect(builds).toEqual([{ changed: [FILE], reason: 'didClose' }]);
   });

   it('removes, and logs no error for, a document whose file is gone when its grace runs out', async () => {
      // A grace outlives what it was granted for: a workspace torn down
      // meanwhile has no file left to revert to.
      const { docs, builds, errors, onDisk, clock } = makeRig(1000);
      open(docs, 'form');
      close(docs, 'form', 'lost');

      onDisk.clear();
      clock.advance(1000);
      await settle();

      expect(builds).toEqual([{ changed: [], deleted: [FILE], reason: 'didClose' }]);
      expect(errors).toEqual([]);
   });

   it('logs no error for a revert whose grace runs out after the connection went away', async () => {
      const { docs, errors, failNextBuild, clock } = makeRig(1000);
      open(docs, 'form');
      close(docs, 'form', 'lost');

      failNextBuild(new Error('Connection is disposed.'));
      clock.advance(1000);
      await settle();

      expect(errors).toEqual([]);
   });

   it('keeps the text of a document whose last client was lost until the grace runs out', async () => {
      const { docs, builds, clock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form', 'lost');
      await settle();

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isOpenInAnyClient(FILE)).toBe(false);
      expect(docs.isRevertPending(FILE)).toBe(true);
      expect(builds).toEqual([]);

      clock.advance(1000);
      await settle();

      expect(docs.get(FILE)).toBeUndefined();
      expect(docs.isRevertPending(FILE)).toBe(false);
      expect(builds).toEqual([{ changed: [FILE], reason: 'didClose' }]);
   });

   it('hands the unsaved text back to the lost client when it opens the document within the grace, and never reverts', async () => {
      const { docs, builds, clock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      open(docs, 'form');
      expect(docs.isRevertPending(FILE)).toBe(false);
      clock.advance(5000);
      await settle();

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isRevertPending(FILE)).toBe(false);
      expect(builds.filter(build => build.reason === 'didClose')).toEqual([]);
   });

   it('keeps the unsaved text for any client lost from the document, not only the last to close', () => {
      const { docs } = makeRig(1000);
      open(docs, 'form');
      open(docs, 'tree');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');
      close(docs, 'tree', 'lost');

      open(docs, 'form');

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('reverts for a lost client that opens the document after its own grace, though a later loss keeps the document waiting', () => {
      const { docs, clock } = makeRig(1000);
      const released: string[] = [];
      docs.onDidCloseLastOpen(event => released.push(event.uri));
      open(docs, 'x');
      open(docs, 'e');
      close(docs, 'x', 'lost');
      docs.applyContentChange(FILE, EDITED, 'e');
      clock.advance(500);
      close(docs, 'e', 'lost');
      clock.advance(700);

      open(docs, 'x');

      expect(released).toEqual([FILE]);
      expect(docs.get(FILE)?.getText()).toBe(DISK);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it.each([
      ['x', 'e'],
      ['e', 'x']
   ])('keeps all the text for two clients lost within the grace with an edit between the losses, %s reopening first', (first, second) => {
      const { docs, clock } = makeRig(1000);
      open(docs, 'x');
      open(docs, 'e');
      close(docs, 'x', 'lost');
      clock.advance(300);
      docs.applyContentChange(FILE, EDITED, 'e');
      close(docs, 'e', 'lost');
      clock.advance(300);

      open(docs, first);
      open(docs, second);

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isOpenInClient(FILE, 'x')).toBe(true);
      expect(docs.isOpenInClient(FILE, 'e')).toBe(true);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('forgets lost clients whose grace has run out while another client keeps the document open', () => {
      const { docs, clock } = makeRig(1000);
      open(docs, LANGUAGE_CLIENT_ID);
      for (let i = 0; i < 5; i++) {
         open(docs, `page#${i}`);
         close(docs, `page#${i}`, 'lost');
      }
      clock.advance(1000);

      open(docs, 'page#5');
      close(docs, 'page#5', 'lost');

      expect(docs.lostClientIds(FILE)).toEqual(['page#5']);
   });

   it('hands the unsaved text back to a lost client within its grace though the wall clock jumps forward', () => {
      const { docs, clock, jumpWallClock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');
      clock.advance(100);
      jumpWallClock(5000);

      open(docs, 'form');

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('reverts for a lost client past its grace though the wall clock jumps back', () => {
      const { docs, clock, jumpWallClock } = makeRig(1000);
      open(docs, 'x');
      open(docs, 'e');
      close(docs, 'x', 'lost');
      jumpWallClock(-60_000);
      clock.advance(5000);
      docs.applyContentChange(FILE, EDITED, 'e');
      close(docs, 'e', 'lost');

      open(docs, 'x');

      expect(docs.get(FILE)?.getText()).toBe(DISK);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('reverts first for another client that opens the document within the grace, which gets the disk text', () => {
      const { docs } = makeRig(1000);
      const released: string[] = [];
      docs.onDidCloseLastOpen(event => released.push(event.uri));
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      open(docs, 'other');

      expect(released).toEqual([FILE]);
      expect(docs.get(FILE)?.getText()).toBe(DISK);
      expect(docs.isOpenInClient(FILE, 'other')).toBe(true);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('releases the unsaved text first for an editor that opens the document within the grace, which keeps its own text', () => {
      const { docs } = makeRig(1000);
      const released: string[] = [];
      docs.onDidCloseLastOpen(event => released.push(event.uri));
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      const editorText = 'in the editor\n';
      docs.notifyDidOpenTextDocument({ textDocument: { uri: FILE, languageId: 'plaintext', version: 0, text: editorText } });

      expect(released).toEqual([FILE]);
      expect(docs.get(FILE)?.getText()).toBe(editorText);
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('cancels the revert for the lost client when it attaches within the grace', async () => {
      const { docs, builds, clock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      expect(docs.attachClient(FILE, 'form')).toBe(true);
      expect(docs.isRevertPending(FILE)).toBe(false);
      clock.advance(5000);
      await settle();

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(builds).toEqual([]);
   });

   it('releases the document instead of attaching another client within the grace', () => {
      const { docs } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      expect(docs.attachClient(FILE, 'diagram')).toBe(false);
      expect(docs.get(FILE)).toBeUndefined();
      expect(docs.isRevertPending(FILE)).toBe(false);
   });

   it('reverts at once on an explicit close, whatever the grace', async () => {
      const { docs, builds } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form', 'closed');
      await settle();

      expect(docs.get(FILE)).toBeUndefined();
      expect(builds).toHaveLength(1);
   });

   it('passes the cause of a session end on to each of its closes', () => {
      const { docs } = makeRig(1000);
      docs.registerSession('form');
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.closeSession('form', 'lost');

      expect(docs.isRevertPending(FILE)).toBe(true);
      expect(docs.get(FILE)?.getText()).toBe(EDITED);
   });

   it('releases a document waiting out the grace when it is deleted, keeping its version sequence', async () => {
      const { docs, builds } = makeRig(1000);
      open(docs, 'form');
      const version = docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      docs.delete(FILE);
      await settle();

      expect(docs.isRevertPending(FILE)).toBe(false);
      expect(docs.get(FILE)).toBeUndefined();
      expect(docs.getAuthor(FILE)).toBeUndefined();
      expect(docs.version(FILE)).toBe(version);
      expect(builds).toHaveLength(1);
   });

   it('announces the last close once the document is really released', () => {
      const { docs, clock } = makeRig(1000);
      const released: string[] = [];
      docs.onDidCloseLastOpen(event => released.push(event.uri));
      open(docs, 'form');

      close(docs, 'form', 'lost');
      expect(released).toEqual([]);

      clock.advance(1000);
      expect(released).toEqual([FILE]);
   });
});

/** A watchdog whose `exit` does nothing, since the connection runs in the test's own process. */
const NO_EXIT: WatchDog = { shutdownReceived: false, initialize: () => undefined, exit: () => undefined };

/**
 * The store listening on the worker end of a real `worker_threads` port, as
 * the LSP head in a worker does, releasing the language client's documents
 * once the port's peer closes; and the editor's connection on the other end.
 */
function listenOnWorkerPort(docs: HydraniumTextDocuments<TextDocument>): {
   editor: ProtocolConnection;
   /** Settles once the worker's end has seen the close, after the store was told. */
   closed: Promise<void>;
   dispose(): void;
} {
   const ports = makeMessagePortPair();
   const worker = createMessagePortTransport(ports.port2);
   const connection = createConnection(logger => createProtocolConnection(worker.reader, worker.writer, logger), NO_EXIT, undefined);
   docs.listen(connection);
   worker.reader.onClose(() => void docs.closeLanguageClientDocuments());
   const closed = new Deferred<void>();
   worker.reader.onClose(() => closed.resolve());
   connection.listen();
   const page = createMessagePortTransport(ports.port1);
   const editor = createProtocolConnection(page.reader, page.writer);
   editor.listen();
   return {
      editor,
      closed: closed.promise,
      dispose: () => {
         connection.dispose();
         ports.dispose();
      }
   };
}

function openInEditor(editor: ProtocolConnection, uri: string): Promise<void> {
   return editor.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'plaintext', version: 1, text: DISK }
   });
}

describe('HydraniumTextDocuments — a language client whose worker port closes', () => {
   it('closes every document the editor held, and each reverts', async () => {
      const { docs, builds } = makeRig();
      const port = listenOnWorkerPort(docs);
      try {
         await openInEditor(port.editor, FILE);
         await openInEditor(port.editor, OTHER_FILE);
         await port.editor.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: FILE, version: 2 },
            contentChanges: [{ text: EDITED }]
         });
         await waitFor(() => docs.get(FILE)?.getText() === EDITED && docs.get(OTHER_FILE) !== undefined);

         port.editor.dispose();

         await waitFor(() => builds.length === 2);
         expect(builds).toEqual([
            { changed: [FILE], reason: 'didClose' },
            { changed: [OTHER_FILE], reason: 'didClose' }
         ]);
         expect(docs.isOpenInClient(FILE, LANGUAGE_CLIENT_ID)).toBe(false);
         expect(docs.get(FILE)).toBeUndefined();
      } finally {
         port.dispose();
      }
   });

   it('closes an open that is still waiting for the workspace when the port closes', async () => {
      const initialized = new Deferred<void>();
      const { docs, builds } = makeRig(undefined, initialized.promise);
      const port = listenOnWorkerPort(docs);
      try {
         await openInEditor(port.editor, FILE);
         port.editor.dispose();
         // The open was handled before the close, so both now wait for the
         // workspace.
         await port.closed;
         initialized.resolve();

         await waitFor(() => builds.length === 1);
         expect(docs.isOpenInClient(FILE, LANGUAGE_CLIENT_ID)).toBe(false);
         expect(docs.get(FILE)).toBeUndefined();
      } finally {
         port.dispose();
      }
   });
});
