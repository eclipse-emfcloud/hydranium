/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Langium runs the provider of each document request inside a workspace lock
 * read, and the lock starts no build while a read runs. On Node, a provider
 * that writes, or waits for a state only a new build reaches, releases its
 * read's hold so the build can start, while every other read keeps holding it
 * off. The real services are needed because the release happens in the real
 * builder, model service and document manager.
 */

import { HydraniumWorkspaceLock, IntegrityPhase, type IntegrityRule, setReadLockScope } from '@hydranium/core';
import { installNodeLockScopes } from '@hydranium/core/node';
import { type AstNode, Deferred, DocumentState, isOperationCancelled, type LangiumDocument, ReadPriority, URI } from '@hydranium/langium';
import { tick } from '@hydranium/protocol/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver';
import { type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'read-lock.domain';

let scratch: ScratchOrderFlowHarness;
let uri: string;

beforeAll(async () => {
   // A limit beyond the test timeout, so a missing release fails rather than waiting it out.
   const lockModule = {
      workspace: { WorkspaceLock: (services: OrderFlowSharedServices) => new HydraniumWorkspaceLock(services, { readHoldLimitMs: 60_000 }) }
   };
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, 'entity Solo {\n   a : string\n}\n'), {
      extraSharedModules: [lockModule]
   });
   uri = URI.file(scratch.workspace.resolve(FILE)).toString();
   // Only this lock releases a read's hold.
   expect(scratch.harness.shared.workspace.WorkspaceLock).toBeInstanceOf(HydraniumWorkspaceLock);
});
afterAll(() => scratch.workspace.dispose());

/** Run `action` as Langium runs a provider, and settle to its value or its error. */
async function inProvider<T>(action: () => Promise<T>): Promise<T | unknown> {
   const lock = scratch.harness.shared.workspace.WorkspaceLock;
   return lock.read(action, ReadPriority.Immediate).catch((error: unknown) => error);
}

/** Whether `promise` has settled, read after a `tick` to assert it has not. */
function track(promise: Promise<unknown>): { readonly settled: boolean } {
   const state = { settled: false };
   const settle = (): void => {
      state.settled = true;
   };
   promise.then(settle, settle);
   return state;
}

/** Register an integrity rule that holds the next build of `uri` in its parse phase until `release` resolves. */
function holdNextBuild(id: string): { held: Promise<void>; release: () => void } {
   const held = new Deferred<void>();
   const release = new Deferred<void>();
   let holding = true;
   const rule: IntegrityRule = {
      id,
      nodeType: 'DomainModel',
      phase: IntegrityPhase.Parsed,
      enforce: async (_node: AstNode, document: LangiumDocument) => {
         if (holding && document.uri.toString() === uri) {
            holding = false;
            held.resolve();
            await release.promise;
         }
         return false;
      }
   };
   scratch.harness.domain.integrity.IntegrityService.register(rule);
   return { held: held.promise, release: () => release.resolve() };
}

describe('a provider inside a workspace lock read', () => {
   it('waits for a state a build queued behind the read reaches', async () => {
      const modelService = scratch.harness.shared.model.ModelService;
      const document = scratch.harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      expect(document?.state).toBe(DocumentState.IndexedReferences);
      const gate = new Deferred<void>();
      const waiting = inProvider(async () => {
         await gate.promise;
         return modelService.waitForDocumentState(uri, DocumentState.Validated);
      });
      const building = modelService.rebuild(uri, DocumentState.Validated);
      const built = track(building);
      await tick();
      expect(built.settled).toBe(false);

      gate.resolve();

      expect(await waiting).toMatchObject({ uri, root: expect.anything() });
      await building;
   });

   it('rebuilds through the model service', async () => {
      const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri));

      expect(outcome).toMatchObject({ uri, root: expect.anything() });
   });

   it('rebuilds while a build queued behind the read waits for it, which the rebuild merges into', async () => {
      const gate = new Deferred<void>();
      const rebuilding = inProvider(async () => {
         await gate.promise;
         return scratch.harness.shared.model.ModelService.rebuild(uri);
      });
      const queued = scratch.harness.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      const built = track(queued);
      await tick();
      expect(built.settled).toBe(false);

      gate.resolve();

      expect(await rebuilding).toMatchObject({ uri, root: expect.anything() });
      await queued;
   });

   it('waits for a builder state that a build queued behind the read reaches', async () => {
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      const builder = scratch.harness.shared.workspace.DocumentBuilder;
      const { held, release } = holdNextBuild('test-hold-builder-state');
      const first = builder.scheduleUpdate([URI.parse(uri)], []);
      await held;
      const gate = new Deferred<void>();
      const waiting = inProvider(async () => {
         await gate.promise;
         return scratch.harness.shared.model.ModelService.waitForBuilderState(DocumentState.Validated);
      });
      // Cancels the held build and queues behind the read, so the builder state drops.
      const second = lock.write(token => builder.update([URI.parse(uri)], [], token));
      release();
      await first;
      const outside = track(scratch.harness.shared.model.ModelService.waitForBuilderState(DocumentState.Validated));
      await tick();
      expect(outside.settled).toBe(false);

      gate.resolve();

      expect(await waiting).toBeUndefined();
      await second;
   });

   it('rebuilds from a read nested in another read of the same lock', async () => {
      const outcome = await inProvider(() => inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri)));

      expect(outcome).toMatchObject({ uri, root: expect.anything() });
   });

   it('takes its hold back once its rebuild is done, so a write queued later waits for it again', async () => {
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      const rebuilt = new Deferred<void>();
      const gate = new Deferred<void>();
      const providing = inProvider(async () => {
         await scratch.harness.shared.model.ModelService.rebuild(uri);
         rebuilt.resolve();
         await gate.promise;
      });
      await rebuilt.promise;

      const writing = lock.write(() => undefined);
      const written = track(writing);
      await tick();
      expect(written.settled).toBe(false);
      gate.resolve();
      await providing;
      await writing;
   });

   it('holds off a write queued while its rebuild runs until the read ends', async () => {
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      const { held, release } = holdNextBuild('test-hold-own-rebuild');
      const gate = new Deferred<void>();
      const events: string[] = [];
      const providing = inProvider(async () => {
         await scratch.harness.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
         events.push('read resumed');
         await gate.promise;
         events.push('read ended');
      });
      await held;
      const writing = lock.write(() => {
         events.push('write');
      });
      release();
      await tick();
      gate.resolve();
      await Promise.all([providing, writing]);

      expect(events).toEqual(['read resumed', 'read ended', 'write']);
   });

   it('requests a recovery build while a write waits for the read', async () => {
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      const gate = new Deferred<void>();
      const providing = inProvider(async () => {
         await gate.promise;
         await scratch.harness.shared.workspace.VersionSyncService.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true });
         return 'built';
      });
      await tick();
      const writing = lock.write(() => undefined);

      gate.resolve();

      expect(await providing).toBe('built');
      await writing;
   });

   it('requests a recovery build that joins one another caller started', async () => {
      const recovery = scratch.harness.shared.workspace.VersionSyncService;
      const { held, release } = holdNextBuild('test-hold-joined-recovery');
      const first = recovery.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true });
      await held;
      const joined = new Deferred<void>();
      const providing = inProvider(async () => {
         const request = recovery.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true });
         joined.resolve();
         await request;
         return 'built';
      });
      await joined.promise;

      release();

      expect(await providing).toBe('built');
      await first;
   });

   it('reads the lock again, queued, while a write waits for the read', async () => {
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      const gate = new Deferred<void>();
      const providing = inProvider(async () => {
         await gate.promise;
         return lock.read(() => 'inner');
      });
      await tick();
      const writing = lock.write(() => undefined);

      gate.resolve();

      expect(await providing).toBe('inner');
      await writing;
   });

   it('still holds a write off while it only reads', async () => {
      const gate = new Deferred<void>();
      const reading = inProvider(() => gate.promise);
      const building = scratch.harness.shared.model.ModelService.rebuild(uri);
      const built = track(building);

      await tick();
      expect(built.settled).toBe(false);
      gate.resolve();
      await reading;
      expect(await building).toMatchObject({ uri });
   });

   it('releases only its own hold, so another read still holds the write off', async () => {
      const gate = new Deferred<void>();
      const other = inProvider(() => gate.promise);
      const rebuilding = inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri));
      const rebuilt = track(rebuilding);

      await tick();
      expect(rebuilt.settled).toBe(false);
      gate.resolve();
      await other;
      expect(await rebuilding).toMatchObject({ uri });
   });

   it('waits for a state the document has reached', async () => {
      const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.waitForDocumentState(uri, DocumentState.Linked));

      expect(outcome).toMatchObject({ uri, root: expect.anything() });
   });

   it('waits for a state a running build reaches', async () => {
      const modelService = scratch.harness.shared.model.ModelService;
      const { held, release } = holdNextBuild('test-hold-build');
      const building = modelService.rebuild(uri, DocumentState.Validated);
      await held;

      const waiting = inProvider(() => modelService.waitForDocumentState(uri, DocumentState.Validated));
      release();

      await building;
      expect(await waiting).toMatchObject({ uri, root: expect.anything() });
   });

   it('waits for a text that a build queued behind the read parses', async () => {
      const models = scratch.harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await scratch.harness.shared.workspace.AstDocumentManager.update(uri, 'entity Solo {\n   b : string\n}\n', session.clientId);
      const gate = new Deferred<void>();
      const waiting = inProvider(async () => {
         await gate.promise;
         return models.waitForDocumentState(uri, DocumentState.Linked);
      });
      const building = models.rebuild(uri);
      await tick();

      gate.resolve();

      expect(await waiting).toMatchObject({ uri, version: scratch.harness.shared.workspace.TextDocuments.version(uri) });
      await building;
      await session.close(uri);
   });

   describe('a provider in a host without a read-lock tracker', () => {
      beforeEach(() => setReadLockScope(undefined));
      afterEach(() => installNodeLockScopes());

      it('rebuilds beside every running request', async () => {
         const gate = new Deferred<void>();
         const other = inProvider(() => gate.promise);

         const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri));

         expect(outcome).toMatchObject({ uri });
         gate.resolve();
         await other;
      });

      it('holds an edit build off until the running request ends', async () => {
         const gate = new Deferred<void>();
         const reading = inProvider(() => gate.promise);
         await tick();
         const building = scratch.harness.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], [], { outsideReads: true });
         const built = track(building);
         await tick();
         const builtWhileReading = built.settled;

         gate.resolve();
         await reading;
         await building;

         expect(builtWhileReading).toBe(false);
      });
   });

   describe('a wait with nothing to wait for', () => {
      /** Run `wait` in a provider while a write is queued behind it, and record the order. */
      async function orderAround(wait: () => Promise<unknown>): Promise<string[]> {
         const order: string[] = [];
         const gate = new Deferred<void>();
         const reading = inProvider(async () => {
            await gate.promise;
            const outcome = await wait().catch((error: unknown) => error);
            order.push(isOperationCancelled(outcome) ? 'wait cancelled' : 'wait ended');
            await tick();
            order.push('read end');
         });
         await tick();
         const writing = scratch.harness.shared.workspace.WorkspaceLock.write(() => {
            order.push('write');
         });
         await tick();
         gate.resolve();
         await Promise.all([reading, writing]);
         return order;
      }

      it('keeps its hold when its token is cancelled before a document state wait', async () => {
         const workspace = scratch.harness.shared.workspace;
         const document = workspace.LangiumDocuments.getDocument(URI.parse(uri))!;
         workspace.DocumentBuilder.resetToState(document, DocumentState.Parsed);

         const order = await orderAround(() =>
            workspace.DocumentBuilder.waitUntil(DocumentState.Linked, document.uri, CancellationToken.Cancelled)
         );
         await scratch.harness.shared.model.ModelService.rebuild(uri);

         expect(order).toEqual(['wait cancelled', 'read end', 'write']);
      });

      /**
       * Run `wait` with a token cancelled once the document state is reached, on a root its open text stays
       * ahead of, and count the builds requested to sync it. No build syncs it meanwhile.
       */
      async function cancelledTextWait<T>(wait: (token: CancellationToken) => Promise<T>): Promise<{ result: T; requested: number }> {
         const workspace = scratch.harness.shared.workspace;
         const session = scratch.harness.shared.model.ModelService.createSession('form');
         await session.open(uri);
         await scratch.harness.shared.model.ModelService.ensureDocumentState(uri);
         const source = new CancellationTokenSource();
         const waitUntil = workspace.DocumentBuilder.waitUntil.bind(workspace.DocumentBuilder);
         vi.spyOn(workspace.DocumentBuilder, 'waitUntil').mockImplementation(async (...args: Parameters<typeof waitUntil>) => {
            const reached = await waitUntil(...args);
            if (args[2] === source.token) {
               source.cancel();
            }
            return reached;
         });
         const synced = vi.spyOn(workspace.VersionSyncService, 'isSyncedTo').mockReturnValue(false);
         const syncTo = vi.spyOn(workspace.VersionSyncService, 'syncTo').mockResolvedValue(undefined);
         try {
            const result = await wait(source.token);
            expect(synced).toHaveBeenCalled();
            return { result, requested: syncTo.mock.calls.length };
         } finally {
            vi.restoreAllMocks();
            await session.close(uri);
         }
      }

      it('keeps its hold when its token is cancelled before a text wait', async () => {
         const { result: order } = await cancelledTextWait(token =>
            orderAround(() => scratch.harness.shared.model.ModelService.waitForDocumentState(uri, DocumentState.Linked, token))
         );

         expect(order).toEqual(['wait cancelled', 'read end', 'write']);
      });

      it('requests no build for a text once its token is cancelled', async () => {
         const { result: outcome, requested } = await cancelledTextWait(token =>
            inProvider(() => scratch.harness.shared.model.ModelService.ensureDocumentState(uri, DocumentState.Linked, token))
         );

         expect({ cancelled: isOperationCancelled(outcome), requested }).toEqual({ cancelled: true, requested: 0 });
      });
   });

   it('deletes a document', async () => {
      const outcome = await inProvider(() => scratch.harness.shared.workspace.AstDocumentManager.delete(uri, 'client-1'));

      expect(outcome).toBeUndefined();
      expect(scratch.harness.shared.workspace.LangiumDocuments.hasDocument(URI.parse(uri))).toBe(false);
   });
});

describe('a queued read under a short read-hold limit', () => {
   let short: ScratchOrderFlowHarness;
   let shortUri: string;

   beforeAll(async () => {
      const lockModule = {
         workspace: { WorkspaceLock: (services: OrderFlowSharedServices) => new HydraniumWorkspaceLock(services, { readHoldLimitMs: 50 }) }
      };
      short = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, 'entity Solo {\n   a : string\n}\n'), {
         extraSharedModules: [lockModule]
      });
      shortUri = URI.file(short.workspace.resolve(FILE)).toString();
   });
   afterAll(() => short.workspace.dispose());

   it('ends a recovery build it requests once the limit passes', async () => {
      // The recovery build reads the lock queued, behind the read that waits for it.
      const lock = short.harness.shared.workspace.WorkspaceLock;
      const outcome = await lock.read(async () => {
         await short.harness.shared.workspace.VersionSyncService.requestRecoveryBuild(URI.parse(shortUri), { stillNeeded: () => true });
         return 'built';
      });

      expect(outcome).toBe('built');
   });
});
