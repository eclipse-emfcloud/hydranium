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
   type WorkerErrorMessage
} from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationCancelled, type LangiumDocument } from '@hydranium/langium';
import { hostHeadsInWorker, reportWorkerError } from '../../src/browser/index.js';
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

function readyMessages(): unknown[] {
   return posted.filter(isWorkerReadyMessage);
}

function errorReports(): WorkerErrorMessage[] {
   return posted.filter(isWorkerErrorMessage);
}

/** What the runner reads for the validating build, with the gate and the build under the test's control. */
function makeWorkspaceServices(uris: string[]) {
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
