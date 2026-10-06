/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { URI } from '@hydranium/langium';
import { type CanonicalUri, Logger } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import {
   DefaultDocumentReleaseHandler,
   type DocumentReleaseDecision,
   DocumentReleaseSkippedError,
   type ReleasedDocument
} from '../../src/documents/document-release-handler.js';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { type ServerSharedServices } from '../../src/langium/module.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
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
    * while queued; an `exists` that rejects.
    */
   readonly faults: { cancelWrites?: boolean; dropWrites?: boolean; existsError?: Error };
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
function makeRig(): Rig {
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
            }
         },
         WorkspaceManager: { ready: Promise.resolve() },
         WorkspaceLock: {
            write: async (action: (token: CancellationToken) => Promise<void>) => {
               if (faults.dropWrites) {
                  return;
               }
               try {
                  await action(CancellationToken.None);
               } catch (err: unknown) {
                  if (!faults.cancelWrites) {
                     throw err;
                  }
               }
            }
         },
         LangiumDocuments: { getDocument: (uri: URI) => (built.has(uri.toString()) ? { uri } : undefined) },
         VersionSyncService: {
            onDidRecordModel: (listener: (document: { uri: URI }) => void) => subscribe(parseListeners, listener),
            requestRecoveryBuild: async (uri: URI, request: { deleted?: boolean; stillNeeded: () => boolean }) => {
               recoveryDeletes.push(request.deleted === true);
               // Queued, as a real one is: it builds after the handler has started waiting.
               await Promise.resolve();
               beforeRecovery.run?.();
               if (!request.stillNeeded()) {
                  return true;
               }
               if (request.deleted) {
                  built.delete(uri.toString());
                  [...updateListeners].forEach(listener => listener([], [uri]));
               } else {
                  parse(uri);
               }
               return true;
            }
         },
         DocumentBuilder: {
            markNextReason: () => undefined,
            onUpdate: (listener: (changed: URI[], deleted: URI[]) => void) => subscribe(updateListeners, listener),
            update: async (changed: URI[], deleted: URI[]) => {
               builds.push({ changed: changed.map(String), deleted: deleted.map(String) });
               deleted.forEach(uri => built.delete(uri.toString()));
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

function makeReleased(isReclaimed: () => boolean = () => false): ReleasedDocument {
   return { uri: KEY, isFor: uri => uri === KEY, isReclaimed };
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
         protected override async requestRecoveryBuild(): Promise<boolean> {
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
         protected override async requestRecoveryBuild(): Promise<boolean> {
            await Promise.resolve();
            reclaimed = true;
            return true;
         }
      }
      const { services, liveListeners } = makeRig();
      await new ReopenedHandler(services).didReleaseDocument(makeReleased(() => reclaimed));
      expect(liveListeners()).toBe(0);
   });
});

describe('DefaultDocumentReleaseHandler — every exit settles and leaves no subscription', () => {
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

   it('reclaimed before the lock: resolves without building', async () => {
      const { services, builds, liveListeners } = makeRig();
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased(() => true)))).toBe('resolved');
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('reclaimed once inside the lock: resolves without building', async () => {
      const { services, builds, liveListeners } = makeRig();
      let asked = 0;
      const released = makeReleased(() => ++asked > 1);
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(released))).toBe('resolved');
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('removed for want of a file: resolves', async () => {
      const { services, onDisk, liveListeners } = makeRig();
      onDisk.clear();
      expect(await outcome(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased()))).toBe('resolved');
      expect(liveListeners()).toBe(0);
   });

   it('cancelled before its parse: resolves once the recovery build parses', async () => {
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

   it('skipped because the connection is gone: rejects at once with the skip', async () => {
      const { services, faults, builds, liveListeners } = makeRig();
      const gone = new Error('Connection is disposed.');
      faults.existsError = gone;
      const err = await rejection(new DefaultDocumentReleaseHandler(services).didReleaseDocument(makeReleased()));
      expect(err).toBeInstanceOf(DocumentReleaseSkippedError);
      expect((err as DocumentReleaseSkippedError).cause).toBe(gone);
      expect(builds).toEqual([]);
      expect(liveListeners()).toBe(0);
   });

   it('skipped because its workspace was torn down: rejects at once with the skip', async () => {
      const { services, liveListeners } = makeRig();
      const gone = Object.assign(new Error('gone'), { code: 'ENOENT', path: FILE.fsPath });
      const Handler = failingWith(gone);
      const err = await rejection(new Handler(services).didReleaseDocument(makeReleased()));
      expect(err).toBeInstanceOf(DocumentReleaseSkippedError);
      expect((err as DocumentReleaseSkippedError).cause).toBe(gone);
      expect(liveListeners()).toBe(0);
   });

   it('failed removal: the recovery build removes the document, and the release settles', async () => {
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

   it('reclaimed before its recovery build runs: settles though that build builds nothing', async () => {
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

   it('skipped after its parse: resolves, since the build holds the file text', async () => {
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

   it('logs a recovery build that fails after a parse settled the release', async () => {
      const rig = makeRig();
      class LateFailureHandler extends DefaultDocumentReleaseHandler {
         protected override async applyReleaseDecision(): Promise<void> {
            throw new Error('build broke');
         }
         protected override async requestRecoveryBuild(): Promise<boolean> {
            await Promise.resolve();
            rig.parse(FILE);
            throw new Error('late recovery broke');
         }
      }
      expect(await outcome(new LateFailureHandler(rig.services).didReleaseDocument(makeReleased()))).toBe('resolved');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(rig.logged.some(line => line.level === 'error' && line.message.includes('late recovery broke'))).toBe(true);
      expect(rig.liveListeners()).toBe(0);
   });

   // No other build is bound to parse the document: the one that cancelled the write builds its own.
   it('discarded while queued: resolves once the recovery build parses it', async () => {
      const rig = makeRig();
      rig.faults.dropWrites = true;
      const settled = outcome(new DefaultDocumentReleaseHandler(rig.services).didReleaseDocument(makeReleased()));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.recoveries()).toBe(1);
      expect(rig.liveListeners()).toBe(0);
   });

   it('cancelled after its parse: requests no recovery build', async () => {
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

   it('failed for a document reclaimed by then: requests no recovery build', async () => {
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
         protected override requestRecoveryBuild(): Promise<boolean> {
            rig.parse(FILE);
            return Promise.resolve(true);
         }
      }
      const settled = outcome(new SynchronousRecovery(rig.services).didReleaseDocument(makeReleased()));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('resolved');
      expect(rig.liveListeners()).toBe(0);
   });
});
