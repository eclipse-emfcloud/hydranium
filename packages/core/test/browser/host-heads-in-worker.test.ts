/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The worker's end of the handshake, headless: the two worker globals the
 * runner reaches, `addEventListener` and `postMessage`, are stubbed on Node's
 * global, and a bootstrap is fired at the captured listener.
 */

import {
   isWorkerErrorMessage,
   isWorkerReadyMessage,
   WORKER_BOOTSTRAP_MESSAGE_TYPE,
   WORKER_BOOTSTRAP_PHASE,
   WORKER_ERROR_MESSAGE_TYPE,
   type HeadPorts,
   type TransferredMessagePort,
   type WorkerBootstrapMessage,
   type WorkerErrorMessage,
   type WorkerReadyMessage
} from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationCancelled, type LangiumDocument } from '@hydranium/langium';
import { hostHeadsInWorker, reportWorkerError } from '../../src/browser/index.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import { DefaultFileSystemProviderRegistry, type WritableFileSystemProvider } from '../../src/langium/workspace/file-system-provider.js';
import { InMemoryFileSystemProvider } from '../../src/langium/workspace/in-memory-file-system-provider.js';
import { persistentFileSystem } from '../../src/langium/workspace/persistent-file-system-provider.js';
import { makeFakeAstNode, makeNoopSharedServices, makeStubLangiumDocuments } from '../../src/testing/index.js';

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener[]>();
const posted: unknown[] = [];

beforeEach(() => {
   vi.stubGlobal('addEventListener', (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
   });
   vi.stubGlobal('postMessage', (message: unknown) => {
      posted.push(message);
   });
});

afterEach(() => {
   vi.unstubAllGlobals();
   listeners.clear();
   posted.length = 0;
});

function fire(type: string, event: unknown): void {
   for (const listener of listeners.get(type) ?? []) {
      listener(event);
   }
}

/** A port-shaped object, enough for the bootstrap, which the runner hands on unread. */
function makePort(): TransferredMessagePort {
   return { postMessage: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, start: () => undefined };
}

function makeBootstrap(): WorkerBootstrapMessage {
   return { type: WORKER_BOOTSTRAP_MESSAGE_TYPE, ports: { lsp: makePort(), data: makePort(), glsp: makePort() } };
}

function readyMessages(): WorkerReadyMessage[] {
   return posted.filter(isWorkerReadyMessage);
}

function errorReports(): WorkerErrorMessage[] {
   return posted.filter(isWorkerErrorMessage);
}

/** What the runner reads for the validating build, with the gate and the build under the test's control. */
function makeWorkspaceServices(uris: string[], fileSystemProvider?: WritableFileSystemProvider) {
   let initialized: () => void = () => undefined;
   let initializationFailed: (error: unknown) => void = () => undefined;
   const workspaceInitialized = new Promise<void>((resolve, reject) => {
      initialized = resolve;
      initializationFailed = reject;
   });
   const builds: { uris: string[]; options: unknown }[] = [];
   let nextBuildFailure: Error | undefined;
   const services = makeNoopSharedServices({
      workspace: {
         FileSystemProvider: fileSystemProvider,
         WorkspaceManager: { workspaceInitialized },
         LangiumDocuments: makeStubLangiumDocuments(uris.map(uri => ({ uri, root: makeFakeAstNode({ $type: 'Element' }) }))),
         DocumentBuilder: {
            build: async (documents: LangiumDocument[], options: unknown) => {
               if (nextBuildFailure) {
                  throw nextBuildFailure;
               }
               builds.push({ uris: documents.map(document => document.uri.toString()), options });
            }
         }
      }
   });
   return {
      services,
      builds,
      initialized: () => initialized(),
      initializationFailed: (error: unknown) => initializationFailed(error),
      failNextBuild: (error: Error) => {
         nextBuildFailure = error;
      }
   };
}

/** The bound slot as the framework binds it: the scheme registry over `host` and the providers registered by scheme. */
function makeRegistry(
   host: WritableFileSystemProvider,
   fileSystemProviders: Record<string, WritableFileSystemProvider> = {}
): WritableFileSystemProvider {
   return new DefaultFileSystemProviderRegistry(
      makeNoopSharedServices<ServerSharedServicesMinimal & { fileSystemProviders: Record<string, WritableFileSystemProvider> }>({
         fileSystemProviders
      }),
      { host }
   );
}

describe('hostHeadsInWorker', () => {
   it('starts the heads on the bootstrap ports with what it awaited, then posts the ready message', async () => {
      const workspace = makeWorkspaceServices([]);
      const started: { ports: HeadPorts; prepared: string }[] = [];
      hostHeadsInWorker(Promise.resolve('restored'), (ports, prepared) => {
         started.push({ ports, prepared });
         expect(readyMessages()).toHaveLength(0);
         return workspace.services;
      });
      const bootstrap = makeBootstrap();

      fire('message', { data: bootstrap });
      await waitFor(() => readyMessages().length > 0);

      expect(started).toEqual([{ ports: bootstrap.ports, prepared: 'restored' }]);
      expect(readyMessages()).toHaveLength(1);
      expect(errorReports()).toEqual([]);
   });

   it('takes a plain value where nothing has to be awaited', async () => {
      const workspace = makeWorkspaceServices([]);
      let prepared: unknown;
      hostHeadsInWorker('plain', (_ports, value) => {
         prepared = value;
         return workspace.services;
      });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(prepared).toBe('plain');
   });

   it('posts the files under the root and each restored path once, keyed as the files are, the store over the seed, when given a root', async () => {
      const seed = { 'a.x': 'seeded a', 'dir/b.x': 'seeded b', 'my file.x': 'seeded c' };
      const store = {
         load: async () => ({ 'a.x': 'stored a', 'my file.x': 'stored c', 'my%20file.x': 'stored c', 'only-stored.x': 'stored d' }),
         write: async () => undefined,
         remove: async () => undefined
      };
      const { fileSystemProvider } = await persistentFileSystem({ store, seed, rootUri: 'file:///w' });
      const workspace = makeWorkspaceServices([], makeRegistry(fileSystemProvider(makeNoopSharedServices())));
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'file:///w/' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(readyMessages()[0].workspace).toEqual({
         rootUri: 'file:///w/',
         files: { 'a.x': 'stored a', 'dir/b.x': 'seeded b', 'my%20file.x': 'stored c', 'only-stored.x': 'stored d' },
         restored: ['a.x', 'my%20file.x', 'only-stored.x']
      });
   });

   it('posts the restored paths of a store keyed absolutely, and none from outside the root', async () => {
      const store = {
         load: async () => ({ 'file:///w/a.x': 'stored a', 'file:///other/a.x': 'stored elsewhere' }),
         write: async () => undefined,
         remove: async () => undefined
      };
      // `her/a.x` is what the outside key leaves once this root's length is cut
      // off it, so only a check of the root keeps it out of `restored`.
      const seed = { 'file:///w/b.x': 'seeded b', 'file:///w/her/a.x': 'seeded c' };
      const { fileSystemProvider } = await persistentFileSystem({ store, seed });
      const workspace = makeWorkspaceServices([], makeRegistry(fileSystemProvider(makeNoopSharedServices())));
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'file:///w' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(readyMessages()[0].workspace).toEqual({
         rootUri: 'file:///w',
         files: { 'a.x': 'stored a', 'b.x': 'seeded b', 'her/a.x': 'seeded c' },
         restored: ['a.x']
      });
   });

   it('posts a file named like a prototype key as any other', async () => {
      const host = new InMemoryFileSystemProvider(makeNoopSharedServices(), {
         seed: Object.fromEntries([['__proto__', 'seeded']]),
         rootUri: 'file:///w'
      });
      const workspace = makeWorkspaceServices([], makeRegistry(host));
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'file:///w' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(Object.keys(readyMessages()[0].workspace?.files ?? {})).toEqual(['__proto__']);
   });

   it("posts the restored paths of the provider registered for the root's scheme", async () => {
      const store = { load: async () => ({ 'a.x': 'stored a' }), write: async () => undefined, remove: async () => undefined };
      const { fileSystemProvider } = await persistentFileSystem({ store, rootUri: 'memory:///w' });
      const host = new InMemoryFileSystemProvider(makeNoopSharedServices(), {});
      const registry = makeRegistry(host, { memory: fileSystemProvider(makeNoopSharedServices()) });
      const workspace = makeWorkspaceServices([], registry);
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'memory:///w' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(readyMessages()[0].workspace).toEqual({ rootUri: 'memory:///w', files: { 'a.x': 'stored a' }, restored: ['a.x'] });
   });

   it('reports a listing that throws under the bootstrap phase and posts no ready message', async () => {
      const host = new InMemoryFileSystemProvider(makeNoopSharedServices(), {});
      vi.spyOn(host, 'readDirectorySync').mockImplementation(() => {
         throw new Error('listing failed');
      });
      const workspace = makeWorkspaceServices([], makeRegistry(host));
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'file:///w' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => errorReports().length > 0);

      expect(errorReports().map(report => report.phase)).toEqual([WORKER_BOOTSTRAP_PHASE]);
      expect(errorReports()[0].message).toContain('listing failed');
      expect(readyMessages()).toHaveLength(0);
   });

   it('posts no restored paths from a filesystem without a store', async () => {
      const host = new InMemoryFileSystemProvider(makeNoopSharedServices(), { seed: { 'a.x': 'seeded a' }, rootUri: 'file:///w' });
      const workspace = makeWorkspaceServices([], makeRegistry(host));
      hostHeadsInWorker(undefined, () => workspace.services, { rootUri: 'file:///w' });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(readyMessages()[0].workspace).toEqual({ rootUri: 'file:///w', files: { 'a.x': 'seeded a' }, restored: [] });
   });

   it('posts no workspace and reads no file without a root', async () => {
      const host = new InMemoryFileSystemProvider(makeNoopSharedServices(), { seed: { 'a.x': 'seeded a' }, rootUri: 'file:///w' });
      const readDirectorySync = vi.spyOn(host, 'readDirectorySync');
      const workspace = makeWorkspaceServices([], makeRegistry(host));
      hostHeadsInWorker(undefined, () => workspace.services);

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(readyMessages()[0].workspace).toBeUndefined();
      expect(readDirectorySync).not.toHaveBeenCalled();
   });

   it('answers one bootstrap and ignores a second', async () => {
      const workspace = makeWorkspaceServices([]);
      let starts = 0;
      hostHeadsInWorker(undefined, () => {
         starts++;
         return workspace.services;
      });

      fire('message', { data: makeBootstrap() });
      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);
      await tick();

      expect(starts).toBe(1);
      expect(readyMessages()).toHaveLength(1);
   });

   it('leaves a message that is no bootstrap to the host', async () => {
      const workspace = makeWorkspaceServices([]);
      let starts = 0;
      hostHeadsInWorker(undefined, () => {
         starts++;
         return workspace.services;
      });

      fire('message', { data: { type: 'host/reset-workspace' } });
      await tick();

      expect(starts).toBe(0);
      expect(posted).toEqual([]);
   });

   it('reports a rejected preparation under the bootstrap phase, once, and posts no ready message', async () => {
      // Rejected before the bootstrap arrives: without the runner marking it
      // handled, the rejection would fail this run as unhandled and reach the
      // page a second time through the rejection listener.
      hostHeadsInWorker(Promise.reject(new Error('store refused')), () => {
         throw new Error('not reached');
      });
      await tick();

      fire('message', { data: makeBootstrap() });
      await waitFor(() => errorReports().length > 0);
      await tick();

      expect(errorReports().map(report => report.phase)).toEqual([WORKER_BOOTSTRAP_PHASE]);
      expect(errorReports()[0].message).toContain('store refused');
      expect(readyMessages()).toHaveLength(0);
   });

   it('reports a start that throws under the bootstrap phase and posts no ready message', async () => {
      hostHeadsInWorker(undefined, () => {
         throw new Error('no port for the data head');
      });

      fire('message', { data: makeBootstrap() });
      await waitFor(() => errorReports().length > 0);

      expect(errorReports().map(report => report.phase)).toEqual([WORKER_BOOTSTRAP_PHASE]);
      expect(errorReports()[0].message).toContain('no port for the data head');
      expect(readyMessages()).toHaveLength(0);
   });

   it('builds every document with validation once the workspace is initialised, after the ready message', async () => {
      const workspace = makeWorkspaceServices(['file:///a.x', 'file:///b.x']);
      hostHeadsInWorker(undefined, () => workspace.services);

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);
      await tick();
      expect(workspace.builds).toEqual([]);

      workspace.initialized();
      await waitFor(() => workspace.builds.length > 0);

      expect(workspace.builds).toEqual([{ uris: ['file:///a.x', 'file:///b.x'], options: { validation: true } }]);
   });

   it('reports a failed validating build under its own phase, leaving the heads up', async () => {
      const workspace = makeWorkspaceServices(['file:///a.x']);
      workspace.failNextBuild(new Error('linker threw'));
      hostHeadsInWorker(undefined, () => workspace.services);

      fire('message', { data: makeBootstrap() });
      workspace.initialized();
      await waitFor(() => errorReports().length > 0);

      expect(readyMessages()).toHaveLength(1);
      expect(errorReports().map(report => report.phase)).toEqual(['workspace validation']);
      expect(errorReports()[0].message).toContain('linker threw');
   });

   it('still builds with validation after a cancelled initial build, which a write during startup causes', async () => {
      const workspace = makeWorkspaceServices(['file:///a.x']);
      hostHeadsInWorker(undefined, () => workspace.services);

      fire('message', { data: makeBootstrap() });
      workspace.initializationFailed(OperationCancelled);
      await waitFor(() => workspace.builds.length > 0);

      expect(workspace.builds[0].options).toEqual({ validation: true });
      expect(errorReports()).toEqual([]);
   });

   it('reports a failed initial build under the validation phase and builds nothing', async () => {
      const workspace = makeWorkspaceServices(['file:///a.x']);
      hostHeadsInWorker(undefined, () => workspace.services);

      fire('message', { data: makeBootstrap() });
      workspace.initializationFailed(new Error('walk failed'));
      await waitFor(() => errorReports().length > 0);

      expect(errorReports().map(report => report.phase)).toEqual(['workspace validation']);
      expect(errorReports()[0].message).toContain('walk failed');
      expect(workspace.builds).toEqual([]);
   });

   it('waits for every started promise before the ready message, and reports one that rejects as a failed bootstrap', async () => {
      const workspace = makeWorkspaceServices([]);
      let headFailed: (error: Error) => void = () => undefined;
      const started = new Promise<void>((_resolve, reject) => {
         headFailed = reject;
      });
      hostHeadsInWorker(undefined, () => ({ shared: workspace.services, started: [started] }));

      fire('message', { data: makeBootstrap() });
      await tick();
      expect(readyMessages()).toHaveLength(0);

      headFailed(new Error('launcher built no connection'));
      await waitFor(() => errorReports().length > 0);

      expect(errorReports().map(report => report.phase)).toEqual([WORKER_BOOTSTRAP_PHASE]);
      expect(errorReports()[0].message).toContain('launcher built no connection');
      expect(readyMessages()).toHaveLength(0);
   });

   it('posts the ready message before the next task, so no head can answer the page first', async () => {
      // A port delivers as a task, so a head built in `start` can answer the
      // page only from the next task on; the page's fatal window must have
      // ended on the ready message by then.
      const workspace = makeWorkspaceServices([]);
      hostHeadsInWorker(Promise.resolve('restored'), () => ({ shared: workspace.services, started: [Promise.resolve()] }));

      fire('message', { data: makeBootstrap() });
      const readyByNextTask = new Promise<number>(resolve => setTimeout(() => resolve(readyMessages().length), 0));

      expect(await readyByNextTask).toBe(1);
   });

   it('posts the ready message once every started promise has resolved', async () => {
      const workspace = makeWorkspaceServices([]);
      hostHeadsInWorker(undefined, () => ({ shared: workspace.services, started: [Promise.resolve()] }));

      fire('message', { data: makeBootstrap() });
      await waitFor(() => readyMessages().length > 0);

      expect(errorReports()).toEqual([]);
   });

   it('drops the OperationCancelled marker a preempted build rejects with, from the page and the console, as the Node host does', () => {
      const workspace = makeWorkspaceServices([]);
      hostHeadsInWorker(undefined, () => workspace.services);
      const preventDefault = vi.fn();

      fire('unhandledrejection', { reason: OperationCancelled, preventDefault });

      expect(errorReports()).toEqual([]);
      expect(preventDefault).toHaveBeenCalledOnce();
   });

   it('reports an unhandled rejection in the worker to the page, leaving its console entry', () => {
      const workspace = makeWorkspaceServices([]);
      hostHeadsInWorker(undefined, () => workspace.services);
      const preventDefault = vi.fn();

      fire('unhandledrejection', { reason: new Error('workspace walk failed'), preventDefault });

      expect(errorReports().map(report => report.phase)).toEqual(['unhandled rejection']);
      expect(errorReports()[0].message).toContain('workspace walk failed');
      expect(preventDefault).not.toHaveBeenCalled();
   });
});

describe('reportWorkerError', () => {
   it('posts an error message carrying the phase and the described error', () => {
      reportWorkerError('workspace reset', new Error('quota exceeded'));

      expect(errorReports()).toHaveLength(1);
      expect(errorReports()[0]).toMatchObject({ type: WORKER_ERROR_MESSAGE_TYPE, phase: 'workspace reset' });
      expect(errorReports()[0].message).toContain('quota exceeded');
   });
});
