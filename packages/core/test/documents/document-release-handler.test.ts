/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { OperationCancelled, URI } from '@hydranium/langium';
import { type CanonicalUri, Deferred, Logger } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver';
import {
   DefaultDocumentReleaseHandler,
   type DocumentReleaseDecision,
   DocumentReleaseSkippedError,
   type ReleasedDocument
} from '../../src/documents/document-release-handler.js';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { type VersionSyncService } from '../../src/documents/version-sync-service.js';
import { type ServerSharedServices } from '../../src/langium/module.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { notFound } from '../../src/langium/workspace/file-not-found.js';
import { type CapturedLine, makeCapturingTracer } from '../../src/testing/index.js';

const FILE = URI.file('/hydranium-test/release.a');
const KEY = FILE.toString() as CanonicalUri;

interface Rig {
   readonly services: ServerSharedServices;
   readonly builds: Array<{ changed: string[]; deleted: string[] }>;
   readonly onDisk: Set<string>;
   /** How many build subscriptions are still live. */
   readonly liveListeners: () => number;
   /**
    * Faults to inject: a write the lock resolves though its action threw, as a
    * cancelled one; a write the lock resolves without running it, discarded
    * while queued; an `exists` that rejects; a recovery build given up; how
    * many rebuilds of the document find no file.
    */
   readonly faults: { cancelWrites?: boolean; dropWrites?: boolean; existsError?: Error; recoveryError?: Error; rebuildMisses?: number };
   /** How many recovery builds were requested. */
   readonly recoveries: () => number;
   /** Whether each recovery build requested asked to remove the document. */
   readonly recoveryDeletes: boolean[];
   /** Run as a recovery build starts, before it asks whether it is still needed. */
   readonly beforeRecovery: { run?: () => void };
   /** Report a parse of `uri`, as a build does. */
   readonly parse: (uri: URI) => void;
   /** The lines the handler logged. */
   readonly logged: CapturedLine[];
}

/** Add `listener` to `listeners` until the returned disposable removes it. */
function subscribe<L>(listeners: Set<L>, listener: L): { dispose(): void } {
   listeners.add(listener);
   return { dispose: () => listeners.delete(listener) };
}

/**
 * A workspace whose builder parses a changed document and drops a deleted one,
 * as Langium's does, and whose recovery build, as the real one, builds nothing
 * for a request no longer needed and removes the document when asked to.
 */
function makeRig(fileSystem: { existsSettled?: (uri: URI) => Promise<boolean> } = {}): Rig {
   const builds: Array<{ changed: string[]; deleted: string[] }> = [];
   const onDisk = new Set([KEY as string]);
   const built = new Set([KEY as string]);
   const parseListeners = new Set<(document: { uri: URI }) => void>();
   const updateListeners = new Set<(changed: URI[], deleted: URI[]) => void>();
   const parse = (uri: URI): void => [...parseListeners].forEach(listener => listener({ uri }));
   const uriPolicy = new DefaultDocumentUriPolicy();
   const faults: Rig['faults'] = {};
   const recoveryDeletes: boolean[] = [];
   const beforeRecovery: Rig['beforeRecovery'] = {};
   const { tracer, lines: logged } = makeCapturingTracer();
   let lockTail: Promise<unknown> = Promise.resolve();
   let latestWrite: CancellationTokenSource | undefined;
   const services = {
      Tracer: { for: () => tracer },
      workspace: {
         FileSystemTaskQueue: new DefaultFileSystemTaskQueue({ workspace: { DocumentUriPolicy: uriPolicy } }),
         FileSystemProvider: {
            exists: async (uri: URI) => {
               if (faults.existsError) {
                  throw faults.existsError;
               }
               return onDisk.has(uri.toString());
            },
            ...fileSystem
         },
         WorkspaceManager: { ready: Promise.resolve() },
         WorkspaceLock: {
            // As Langium's lock: one write at a time, each queued write cancels
            // the one before it, and a write that stops on its cancellation resolves.
            write: (action: (token: CancellationToken) => Promise<void>) => {
               latestWrite?.cancel();
               const source = new CancellationTokenSource();
               latestWrite = source;
               const run = lockTail.then(async () => {
                  if (faults.dropWrites) {
                     return;
                  }
                  try {
                     await action(source.token);
                  } catch (err: unknown) {
                     if (!faults.cancelWrites && err !== OperationCancelled) {
                        throw err;
                     }
                  }
               });
               lockTail = run.catch(() => undefined);
               return run;
            }
         },
         LangiumDocuments: { getDocument: (uri: URI) => (built.has(uri.toString()) ? { uri } : undefined) },
         VersionSyncService: {
            onDidRecordModel: (listener: (document: { uri: URI }) => void) => subscribe(parseListeners, listener),
            requestRecoveryBuild: (async (uri, request) => {
               recoveryDeletes.push(request.deleted === true);
               // Queued, as a real one is: it builds after the handler has started waiting.
               await Promise.resolve();
               beforeRecovery.run?.();
               if (!request.stillNeeded()) {
                  return;
               }
               if (faults.recoveryError) {
                  throw faults.recoveryError;
               }
               if (request.deleted) {
                  built.delete(uri.toString());
                  [...updateListeners].forEach(listener => listener([], [uri]));
               } else {
                  parse(uri);
               }
            }) satisfies VersionSyncService['requestRecoveryBuild']
         },
         DocumentBuilder: {
            markNextReason: () => undefined,
            onUpdate: (listener: (changed: URI[], deleted: URI[]) => void) => subscribe(updateListeners, listener),
            update: async (changed: URI[], deleted: URI[], token: CancellationToken = CancellationToken.None) => {
               builds.push({ changed: changed.map(String), deleted: deleted.map(String) });
               deleted.forEach(uri => built.delete(uri.toString()));
               // As Langium's update: a cancelled one has deleted and announced,
               // and stops before it reads a file or parses.
               if (token.isCancellationRequested) {
                  [...updateListeners].forEach(listener => listener(changed, deleted));
                  throw OperationCancelled;
               }
               if (faults.rebuildMisses && changed.some(uri => uri.toString() === KEY)) {
                  faults.rebuildMisses--;
                  throw notFound(`No file at ${FILE.fsPath}`, FILE);
               }
               changed.forEach(parse);
               [...updateListeners].forEach(listener => listener(changed, deleted));
            }
         }
      }
   } as unknown as ServerSharedServices;
   return {
      services,
      builds,
      onDisk,
      faults,
      parse,
      logged,
      recoveries: () => recoveryDeletes.length,
      recoveryDeletes,
      beforeRecovery,
      liveListeners: () => parseListeners.size + updateListeners.size
   };
}

function makeReleased(isReclaimed: () => boolean = () => false, wasOnDisk = true): ReleasedDocument {
   return { uri: KEY, wasOnDisk, isFor: uri => uri === KEY, isReclaimed };
}

describe('DefaultDocumentReleaseHandler', () => {
   it('rebuilds a document its file backs', async () => {
      const { services, builds, liveListeners } = makeRig();
      const released = makeReleased();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(released);
      expect(builds).toEqual([{ changed: [KEY], deleted: [] }]);
      expect(liveListeners()).toBe(0);
   });

   it('removes a document with no file', async () => {
      const { services, builds, onDisk } = makeRig();
      onDisk.clear();
      const released = makeReleased();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(released);
      expect(builds).toEqual([{ changed: [], deleted: [KEY] }]);
   });

   it('rebuilds a document whose missed file the provider finds once settled', async () => {
      const { services, builds, onDisk } = makeRig({ existsSettled: async () => true });
      onDisk.clear();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([{ changed: [KEY], deleted: [] }]);
   });

   it('removes at once, without settling, a document the store knew had no file', async () => {
      let settles = 0;
      const { services, builds, onDisk } = makeRig({
         existsSettled: async () => {
            settles++;
            return true;
         }
      });
      onDisk.clear();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased(undefined, false));
      expect(builds).toEqual([{ changed: [], deleted: [KEY] }]);
      expect(settles).toBe(0);
   });

   it('removes a document whose missed file the provider confirms gone', async () => {
      const { services, builds, onDisk } = makeRig({ existsSettled: async () => false });
      onDisk.clear();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([{ changed: [], deleted: [KEY] }]);
   });

   it('settles a miss outside the disk queue, so a write queued for the file runs meanwhile', async () => {
      const settling = new Deferred<boolean>();
      const asked = new Deferred();
      const { services, builds, onDisk } = makeRig({
         existsSettled: () => {
            asked.resolve();
            return settling.promise;
         }
      });
      onDisk.clear();
      const release = new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      await asked.promise;

      // Would wait on the settle forever if it held the queue.
      await services.workspace.FileSystemTaskQueue.enqueue(KEY, async () => onDisk.add(KEY));
      settling.resolve(true);
      await release;

      expect(builds).toEqual([{ changed: [KEY], deleted: [] }]);
   });

   it('rebuilds again a document whose rebuild missed a file the provider then finds', async () => {
      const { services, builds, faults } = makeRig({ existsSettled: async () => true });
      faults.rebuildMisses = 1;
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [KEY], deleted: [] }
      ]);
   });

   it('removes a document whose rebuild missed a file the provider confirms gone', async () => {
      const { services, builds, faults } = makeRig({ existsSettled: async () => false });
      faults.rebuildMisses = 1;
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [], deleted: [KEY] }
      ]);
   });

   it('removes a document whose rebuild misses its file again after the provider found it back', async () => {
      const { services, builds, faults } = makeRig({ existsSettled: async () => true });
      faults.rebuildMisses = 2;
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [KEY], deleted: [] },
         { changed: [], deleted: [KEY] }
      ]);
   });

   it('carries out what an overridden redecideRelease answers after each missed rebuild', async () => {
      const { services, builds, faults } = makeRig({ existsSettled: async () => false });
      faults.rebuildMisses = 2;
      const asked: number[] = [];
      class Persisting extends DefaultDocumentReleaseHandler {
         protected override async redecideRelease(
            _released: ReleasedDocument,
            _target: URI,
            misses: number
         ): Promise<DocumentReleaseDecision> {
            asked.push(misses);
            return 'rebuild';
         }
      }
      await new Persisting(services).didReleaseDocument(makeReleased());
      expect(asked).toEqual([1, 2]);
      // The default would have removed it: the provider confirms the file gone.
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [KEY], deleted: [] },
         { changed: [KEY], deleted: [] }
      ]);
   });

   it("settles a rebuild's missed file within its write, so no build reads the reset document meanwhile", async () => {
      const settling = new Deferred<boolean>();
      const asked = new Deferred();
      const { services, builds, faults, recoveryDeletes } = makeRig({
         existsSettled: () => {
            asked.resolve();
            return settling.promise;
         }
      });
      faults.rebuildMisses = 1;
      const release = new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      await asked.promise;

      // How many builds the release had made when another write got the lock.
      const seen: number[] = [];
      const queued = services.workspace.WorkspaceLock.write(async () => {
         seen.push(builds.length);
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(seen).toEqual([]);
      settling.resolve(true);
      await Promise.all([release, queued]);

      expect(seen).toEqual([2]);
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [KEY], deleted: [] }
      ]);
      // The queued write cancelled the second rebuild, so a recovery build rebuilds it.
      expect(recoveryDeletes).toEqual([false]);
   });

   it('removes a document whose missed file settles gone though a write queued meanwhile cancels the removal', async () => {
      const settling = new Deferred<boolean>();
      const asked = new Deferred();
      const { services, builds, faults, recoveries } = makeRig({
         existsSettled: () => {
            asked.resolve();
            return settling.promise;
         }
      });
      faults.rebuildMisses = 1;
      const release = new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased());
      await asked.promise;

      const queued = services.workspace.WorkspaceLock.write(async () => undefined);
      settling.resolve(false);
      await Promise.all([release, queued]);

      // A removal deletes before it checks its cancellation, so nothing is left to recover.
      expect(builds).toEqual([
         { changed: [KEY], deleted: [] },
         { changed: [], deleted: [KEY] }
      ]);
      expect(services.workspace.LangiumDocuments.getDocument(FILE)).toBeUndefined();
      expect(recoveries()).toBe(0);
   });

   it('leaves a document a client reclaims while its missed file settles to that client', async () => {
      const settling = new Deferred<boolean>();
      const asked = new Deferred();
      let reclaimed = false;
      const { services, builds, faults } = makeRig({
         existsSettled: () => {
            asked.resolve();
            return settling.promise;
         }
      });
      faults.rebuildMisses = 1;
      const release = new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased(() => reclaimed));
      await asked.promise;

      reclaimed = true;
      settling.resolve(false);
      await release;

      // The missed rebuild alone: no removal of the reclaimed document.
      expect(builds).toEqual([{ changed: [KEY], deleted: [] }]);
   });

   it('leaves a document a client reclaimed to that client', async () => {
      const { services, builds } = makeRig();
      await new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased(() => true));
      expect(builds).toEqual([]);
   });

   it('logs how each release went, a reclaimed one as building nothing', async () => {
      const outcomes = async (reclaimed: boolean): Promise<string[]> => {
         const rig = makeRig();
         await new DefaultDocumentReleaseHandler(rig.services).didReleaseDocument(makeReleased(() => reclaimed));
         return rig.logged.filter(line => line.level === 'debug' && line.message.includes('Release outcome')).map(line => line.message);
      };
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      try {
         expect(await outcomes(true)).toEqual([expect.stringContaining('Release outcome: reclaimed by a client, built nothing')]);
         expect(await outcomes(false)).toEqual([expect.stringContaining('Release outcome: completed rebuild, parsed')]);
      } finally {
         Logger.setLevel(previous);
      }
   });

   it('settles an overridden applyReleaseDecision once the build it runs removes the document', async () => {
      class RemovingBuild extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(target: URI): Promise<void> {
            await this.services.workspace.DocumentBuilder.update([], [target]);
         }
      }
      const { services, builds, liveListeners } = makeRig();
      await new RemovingBuild(services).didReleaseDocument(makeReleased());
      expect(builds).toEqual([{ changed: [], deleted: [KEY] }]);
      expect(liveListeners()).toBe(0);
   });

   it('settles an overridden applyReleaseDecision that builds nothing through a recovery build', async () => {
      class BuildingNothing extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {}
      }
      const rig = makeRig();
      const settled = new BuildingNothing(rig.services).didReleaseDocument(makeReleased()).then(() => 'resolved');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.recoveryDeletes).toEqual([false]);
      expect(rig.liveListeners()).toBe(0);
   });

   it('logs under the name of the class that runs, a subclass included', () => {
      const rig = makeRig();
      const names: string[] = [];
      const services = {
         ...rig.services,
         Tracer: {
            for: (name: string) => {
               names.push(name);
               return rig.services.Tracer.for(name);
            }
         }
      } as unknown as ServerSharedServices;
      class PolicyHandler extends DefaultDocumentReleaseHandler {}
      new PolicyHandler(services);
      expect(names).toEqual(['PolicyHandler']);
   });

   it('carries out an overridden decision', async () => {
      // The file is there, but the policy chooses to drop the document.
      class RemovingHandler extends DefaultDocumentReleaseHandler {
         protected override async decideRelease(): Promise<DocumentReleaseDecision> {
            return 'remove';
         }
      }
      const { services, builds } = makeRig();
      const released = makeReleased();
      await new RemovingHandler(services).didReleaseDocument(released);
      expect(builds).toEqual([{ changed: [], deleted: [KEY] }]);
   });

   it('rejects when an overridden recovery build rejects, and stops listening', async () => {
      class FailingHandler extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
         protected override async requestRecoveryBuild(): Promise<void> {
            throw new Error('recovery broke');
         }
      }
      const { services, liveListeners } = makeRig();
      const released = makeReleased();
      await expect(new FailingHandler(services).didReleaseDocument(released)).rejects.toThrow('recovery broke');
      expect(liveListeners()).toBe(0);
   });

   it('resolves once the recovery build has parsed, and stops listening', async () => {
      class FailingBuildHandler extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
      }
      const { services, liveListeners } = makeRig();
      const released = makeReleased();
      await new FailingBuildHandler(services).didReleaseDocument(released);
      expect(liveListeners()).toBe(0);
   });

   it('resolves once a recovery build finds the document reclaimed, though it builds nothing', async () => {
      let reclaimed = false;
      class ReopenedHandler extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
         // A client opened the document meanwhile, so the build is no longer needed.
         protected override async requestRecoveryBuild(): Promise<void> {
            await Promise.resolve();
            reclaimed = true;
         }
      }
      const { services, liveListeners } = makeRig();
      await new ReopenedHandler(services).didReleaseDocument(makeReleased(() => reclaimed));
      expect(liveListeners()).toBe(0);
   });
});

describe('DefaultDocumentReleaseHandler every exit settles and leaves no subscription', () => {
   /** A handler whose build of the release throws `err` before any parse. */
   const failingWith = (err: unknown): typeof DefaultDocumentReleaseHandler =>
      class extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw err;
         }
      };
   const outcome = (settled: Promise<void>): Promise<string> =>
      settled.then(
         () => 'resolved',
         (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`
      );

   it('resolves without building when reclaimed before the lock', async () => {
      const { services, builds, liveListeners } = makeRig();
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased(() => true)))).toBe('resolved');
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('resolves without building when reclaimed once inside the lock', async () => {
      const { services, builds, liveListeners } = makeRig();
      let asked = 0;
      const released = makeReleased(() => ++asked > 1);
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(released))).toBe('resolved');
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('resolves when removed for want of a file', async () => {
      const { services, onDisk, liveListeners } = makeRig();
      onDisk.clear();
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(liveListeners()).toBe(0);
   });

   it('resolves once the recovery build parses when cancelled before its parse', async () => {
      const { services, faults, liveListeners } = makeRig();
      faults.cancelWrites = true;
      const Handler = failingWith(new Error('cancelled'));
      expect(await outcome(new Handler(services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(liveListeners()).toBe(0);
   });

   /** What `settled` rejected with; `undefined` when it resolved. */
   const rejection = (settled: Promise<void>): Promise<unknown> =>
      settled.then(
         () => undefined,
         (err: unknown) => err
      );

   it('rejects at once with the skip when skipped because the connection is gone', async () => {
      const { services, faults, builds, liveListeners } = makeRig();
      const gone = new Error('Connection is disposed.');
      faults.existsError = gone;
      const err = await rejection(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased()));
      expect(err).toBeInstanceOf(DocumentReleaseSkippedError);
      expect((err as DocumentReleaseSkippedError).cause).toBe(gone);
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('rejects at once with the skip when skipped because its workspace was torn down', async () => {
      const { services, liveListeners } = makeRig();
      const gone = Object.assign(new Error('gone'), { code: 'ENOENT', path: FILE.fsPath });
      const Handler = failingWith(gone);
      const err = await rejection(new Handler(services).didReleaseDocument(makeReleased()));
      expect(err).toBeInstanceOf(DocumentReleaseSkippedError);
      expect((err as DocumentReleaseSkippedError).cause).toBe(gone);
      expect(liveListeners()).toBe(0);
   });

   it('settles after a failed removal, the recovery build removing the document', async () => {
      const rig = makeRig();
      class FailingRemoval extends DefaultDocumentReleaseHandler {
         protected override async decideRelease(): Promise<DocumentReleaseDecision> {
            return 'remove';
         }
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
      }
      expect(await outcome(new FailingRemoval(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(rig.recoveryDeletes).toEqual([true]);
      expect(rig.services.workspace.LangiumDocuments.getDocument(FILE)).toBeUndefined();
      expect(rig.liveListeners()).toBe(0);
   });

   it('settles when reclaimed before its recovery build runs, though that build builds nothing', async () => {
      const rig = makeRig();
      let reclaimed = false;
      rig.beforeRecovery.run = () => {
         reclaimed = true;
      };
      const Handler = failingWith(new Error('build broke'));
      const settled = outcome(new Handler(rig.services).didReleaseDocument(makeReleased(() => reclaimed)));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.recoveries()).toBe(1);
      expect(rig.liveListeners()).toBe(0);
   });

   it('resolves when skipped after its parse, since the build holds the file text', async () => {
      const rig = makeRig();
      class ParsedThenGone extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            rig.parse(FILE);
            throw new Error('Connection is disposed.');
         }
      }
      expect(await outcome(new ParsedThenGone(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(rig.recoveries()).toBe(0);
      expect(rig.liveListeners()).toBe(0);
   });

   it('logs a recovery build that fails after a parse settled the release at debug, since the release got its parse', async () => {
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      const rig = makeRig();
      class LateFailureHandler extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
         protected override async requestRecoveryBuild(): Promise<void> {
            await Promise.resolve();
            rig.parse(FILE);
            throw new Error('late recovery broke');
         }
      }
      try {
         expect(await outcome(new LateFailureHandler(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
         await waitFor(() => rig.logged.some(line => line.message.includes('late recovery broke')));
         expect(rig.logged.filter(line => line.message.includes('late recovery broke')).map(line => line.level)).toEqual(['debug']);
         expect(rig.liveListeners()).toBe(0);
      } finally {
         Logger.setLevel(previous);
      }
   });

   it('logs a recovery build that fails after a revert that parsed and then failed at debug, since the release has its parse', async () => {
      const previous = Logger.getLevel();
      Logger.setLevel('debug');
      const rig = makeRig();
      rig.faults.recoveryError = new Error('recovery given up');
      class ParsedThenFailed extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            rig.parse(FILE);
            throw new Error('build broke');
         }
      }
      try {
         expect(await outcome(new ParsedThenFailed(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
         await waitFor(() => rig.logged.some(line => line.message.includes('recovery given up')));
         expect(rig.logged.filter(line => line.message.includes('recovery given up')).map(line => line.level)).toEqual(['debug']);
      } finally {
         Logger.setLevel(previous);
      }
   });

   it('warns, with its stack, about a failed revert that a recovery build took over', async () => {
      const rig = makeRig();
      const Handler = failingWith(new Error('build broke'));
      expect(await outcome(new Handler(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
      const lines = rig.logged.filter(line => line.message.includes('build broke'));
      expect(lines.map(line => line.level)).toEqual(['warn']);
      expect(lines[0].message).toMatch(/\n\s+at /);
   });

   it('rejects with a given-up recovery build as the cause, after warning about the revert it took over', async () => {
      const rig = makeRig();
      const given = new Error('recovery given up');
      rig.faults.recoveryError = given;
      const Handler = failingWith(new Error('build broke'));
      const failure = await new Handler(rig.services).didReleaseDocument(makeReleased()).then(
         () => undefined,
         (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBe(given);
      expect(rig.logged.filter(line => line.level === 'error')).toEqual([]);
      expect(rig.liveListeners()).toBe(0);
   });

   // No other build is bound to parse the document: the one that cancelled the write builds its own.
   it('resolves once the recovery build parses it when discarded while queued', async () => {
      const rig = makeRig();
      rig.faults.dropWrites = true;
      const settled = outcome(new DefaultDocumentReleaseHandler(rig.services).didReleaseDocument(makeReleased()));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.recoveries()).toBe(1);
      expect(rig.liveListeners()).toBe(0);
   });

   it('requests no recovery build when cancelled after its parse', async () => {
      const rig = makeRig();
      rig.faults.cancelWrites = true;
      class ParsedThenCancelled extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            rig.parse(FILE);
            throw new Error('cancelled');
         }
      }
      expect(await outcome(new ParsedThenCancelled(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(rig.recoveries()).toBe(0);
      expect(rig.liveListeners()).toBe(0);
   });

   it('requests no recovery build when failed for a document reclaimed by then', async () => {
      const rig = makeRig();
      let asked = 0;
      // Not reclaimed before the lock nor inside it, reclaimed once the build has failed.
      const released = makeReleased(() => ++asked > 2);
      const Handler = failingWith(new Error('build broke'));
      expect(await outcome(new Handler(rig.services).didReleaseDocument(released))).toBe('resolved');
      expect(rig.recoveries()).toBe(0);
      expect(rig.liveListeners()).toBe(0);
   });

   it('resolves when the recovery build records the document before it returns', async () => {
      const rig = makeRig();
      class SynchronousRecovery extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
         protected override requestRecoveryBuild(): Promise<void> {
            rig.parse(FILE);
            return Promise.resolve();
         }
      }
      const settled = outcome(new SynchronousRecovery(rig.services).didReleaseDocument(makeReleased()));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.liveListeners()).toBe(0);
   });
});
