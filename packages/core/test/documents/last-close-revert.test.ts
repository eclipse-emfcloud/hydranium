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

import { makeFakeClock, type FakeClock } from '@hydranium/protocol/testing';
import { URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { makeNoopTracer } from '../../src/testing/index.js';

const FILE = URI.file('/hydranium-test/revert.a').toString();
const DISK = 'on disk\n';
const EDITED = 'edited\n';

interface RevertRig {
   readonly docs: HydraniumTextDocuments<TextDocument>;
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
}

function makeRig(revertGraceMs?: number): RevertRig {
   const clock = makeFakeClock();
   const builds: Array<{ changed: string[]; deleted?: string[]; reason: string | undefined }> = [];
   const errors: string[] = [];
   let staged: string | undefined;
   let queueTail: Promise<unknown> = Promise.resolve();
   let lockTail: Promise<unknown> = Promise.resolve();
   let nextBuildFailure: Error | undefined;
   const onDisk = new Set<string>([FILE]);
   let existenceChecks = 0;
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
      Clock: clock,
      Tracer: { for: () => tracer },
      workspace: {
         DocumentUriPolicy: new DefaultDocumentUriPolicy(),
         WorkspaceManager: { ready: Promise.resolve() },
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
         AstDocumentManager: {
            queueDiskTask: <T>(_uri: string, task: () => Promise<T>): Promise<T> => {
               const result = queueTail.then(task);
               queueTail = result.catch(() => undefined);
               return result;
            }
         }
      }
   } as unknown as ServerSharedServices;
   const docs = new HydraniumTextDocuments<TextDocument>(services, { revertGraceMs });
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
         queueTail = queueTail.then(() => held);
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
      const services = docs['services'] as unknown as { workspace: { AstDocumentManager: { queueDiskTask: () => Promise<never> } } };
      services.workspace.AstDocumentManager.queueDiskTask = () => Promise.reject(new Error('queue broke'));
      open(docs, 'form');

      close(docs, 'form');
      await settle();

      expect(errors.some(message => message.includes('queue broke'))).toBe(true);
   });

   it('releases the document at once when the grace is 0, even for a lost client', () => {
      const { docs } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      close(docs, 'form', 'lost');

      expect(docs.get(FILE)).toBeUndefined();
      expect(docs.isRevertPending(FILE)).toBe(false);
   });
});

describe('HydraniumTextDocuments — revert grace', () => {
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

   it('hands the unsaved text to a client that opens the document within the grace, and never reverts', async () => {
      const { docs, builds, clock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      open(docs, 'form-again');
      expect(docs.isRevertPending(FILE)).toBe(false);
      clock.advance(5000);
      await settle();

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(docs.isRevertPending(FILE)).toBe(false);
      expect(builds.filter(build => build.reason === 'didClose')).toEqual([]);
   });

   it('cancels the revert for a client that attaches within the grace', async () => {
      const { docs, builds, clock } = makeRig(1000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      close(docs, 'form', 'lost');

      expect(docs.attachClient(FILE, 'diagram')).toBe(true);
      expect(docs.isRevertPending(FILE)).toBe(false);
      clock.advance(5000);
      await settle();

      expect(docs.get(FILE)?.getText()).toBe(EDITED);
      expect(builds).toEqual([]);
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
