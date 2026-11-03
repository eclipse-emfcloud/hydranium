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
 * read, and the lock starts no build or write while a read runs. On Node, a
 * wait inside a read for one rejects with `ReadLockWaitError` once the read
 * has run on for the lock's grace period, rather than wait forever. A read
 * that ends first did not await it. The real services are needed because the
 * checks are in the real builder, model service and recovery builds.
 */

import {
   createSynchronousReadLockScope,
   DefaultHydraniumWorkspaceLock,
   IntegrityPhase,
   type IntegrityRule,
   ReadLockWaitError,
   runInReadLockScope,
   setReadLockScope
} from '@hydranium/core';
import { installNodeReadLockScope } from '@hydranium/core/node';
import { type AstNode, Deferred, DocumentState, type LangiumDocument, ReadPriority, URI } from '@hydranium/langium';
import { makeCapturingTracer } from '@hydranium/core/testing';
import { tick } from '@hydranium/protocol/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import { isDomainModel, isEntity } from '../src/language-server/ast.js';
import { type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'read-lock.domain';
const TEXT = 'entity Solo {\n   a : string\n}\n';
const GRACE_MS = 100;

let scratch: ScratchOrderFlowHarness;
const capture = makeCapturingTracer();
let uri: string;

beforeAll(async () => {
   // A short grace, so a refused wait fails fast.
   const lockModule = {
      workspace: {
         WorkspaceLock: (services: OrderFlowSharedServices) => new DefaultHydraniumWorkspaceLock(services, { readWaitGraceMs: GRACE_MS })
      }
   };
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, TEXT), {
      extraSharedModules: [lockModule, { Tracer: () => capture.tracer }]
   });
   uri = URI.file(scratch.workspace.resolve(FILE)).toString();
});
afterAll(() => scratch.dispose());
// A refused wait leaves its build queued, so each test starts once the builds before it have run.
afterEach(async () => {
   await scratch.harness.shared.workspace.WorkspaceLock.write(() => undefined);
   await scratch.harness.shared.workspace.WorkspaceLock.read(() => undefined);
   // Restored even when a test fails, so its delete, change or spy cannot fail the tests after it.
   vi.restoreAllMocks();
   const path = scratch.workspace.resolve(FILE);
   if (!existsSync(path) || readFileSync(path, 'utf8') !== TEXT) {
      await scratch.workspace.write(FILE, TEXT);
      await scratch.harness.shared.model.ModelService.rebuild(uri);
   }
});

/**
 * Run `action` inside a lock read, as an adopter's own `read` does, and settle
 * to its value or its error. A Langium document request, which awaits its
 * document first, is driven over a real LSP connection in the Node-only suite.
 */
async function inProvider<T>(action: () => Promise<T>, priority = ReadPriority.Immediate): Promise<T | unknown> {
   const lock = scratch.harness.shared.workspace.WorkspaceLock;
   return lock.read(action, priority).catch((error: unknown) => error);
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

/** The builder's build-ended and update listeners, none of which a refused wait leaves behind. */
function builderListeners(): number[] {
   const builder = scratch.harness.shared.workspace.DocumentBuilder;
   return [
      (Reflect.get(builder, 'buildEndedListeners') as Set<unknown>).size,
      (Reflect.get(builder, 'updateListeners') as unknown[]).length
   ];
}

/** Numbers each text a test writes, so no run finds its text already parsed. */
let texts = 0;

/** Register an integrity rule that holds the next build of `uri` in its parse phase until `release` resolves. */
let holds = 0;

function holdNextBuild(id: string): { held: Promise<void>; release: () => void } {
   const held = new Deferred<void>();
   const release = new Deferred<void>();
   let holding = true;
   const rule: IntegrityRule = {
      // Unique per call, since each host's run registers its own.
      id: `${id}-${++holds}`,
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

// A browser host has no async context, so it marks a read only until its action's first `await`.
describe.each([
   ['on Node', installNodeReadLockScope],
   ['without async context', () => setReadLockScope(createSynchronousReadLockScope())]
])('a provider inside a request %s', (_host, installScope) => {
   beforeAll(installScope);
   afterAll(installNodeReadLockScope);

   it('holds off a build queued while it runs until it ends', async () => {
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

   it('waits for a state the document has reached', async () => {
      const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.waitForDocumentState(uri, DocumentState.Linked));

      expect(outcome).toMatchObject({ uri, root: expect.anything() });
   });

   it('starts a build it does not await', async () => {
      let building!: Promise<void>;

      const outcome = await inProvider(async () => {
         building = scratch.harness.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
         return 'started';
      });

      expect(outcome).toBe('started');
      await building;
   });

   it('leaves no failure behind when a build it does not await fails', async () => {
      const builder = scratch.harness.shared.workspace.DocumentBuilder;
      const document = scratch.harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))!;
      builder.resetToState(document, DocumentState.Parsed);
      const failing = builder.onBuildPhase(DocumentState.IndexedContent, () => {
         throw new Error('build failed');
      });

      capture.lines.length = 0;

      const outcome = await inProvider(async () => {
         // A queued write makes the builder's check for waits it left behind queue behind it, past the grace period.
         void scratch.harness.shared.workspace.WorkspaceLock.write(() => undefined);
         void builder.build([document], {}).catch(() => undefined);
         await new Promise(resolve => setTimeout(resolve, GRACE_MS * 3));
         return 'ended';
      });
      failing.dispose();
      await scratch.harness.shared.model.ModelService.rebuild(uri);

      expect(outcome).toBe('ended');
      expect(capture.lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([]);
   });

   it('rebuilds without awaiting it, which ends once the request has', async () => {
      let rebuilding!: Promise<unknown>;

      const outcome = await inProvider(async () => {
         rebuilding = scratch.harness.shared.model.ModelService.rebuild(uri);
         return 'started';
      });

      expect(outcome).toBe('started');
      expect(await rebuilding).toMatchObject({ uri });
   });

   it('waits for a state a running build reaches', async () => {
      const modelService = scratch.harness.shared.model.ModelService;
      const { held, release } = holdNextBuild('test-hold-running-build');
      const building = modelService.rebuild(uri, DocumentState.Validated);
      await held;

      const waiting = inProvider(() => modelService.waitForDocumentState(uri, DocumentState.Validated));
      release();

      await building;
      expect(await waiting).toMatchObject({ uri, root: expect.anything() });
   });

   it('waits for a state a running build reaches after the grace period', async () => {
      const modelService = scratch.harness.shared.model.ModelService;
      const { held, release } = holdNextBuild('test-hold-slow-build');
      const building = modelService.rebuild(uri, DocumentState.Validated);
      await held;

      const waiting = inProvider(() => modelService.waitForDocumentState(uri, DocumentState.Validated));
      setTimeout(release, GRACE_MS * 3);

      await building;
      expect(await waiting).toMatchObject({ uri, root: expect.anything() });
   });

   it.each(['waitForDocumentState', 'ensureDocumentState'] as const)(
      'is refused, and logs no failure, when it calls %s on a document no build has reached',
      async method => {
         capture.lines.length = 0;
         const workspace = scratch.harness.shared.workspace;
         workspace.DocumentBuilder.resetToState(workspace.LangiumDocuments.getDocument(URI.parse(uri))!, DocumentState.Parsed);
         const listeners = builderListeners();
         let left: number[] = [];

         // Counted inside the request, before a build it queued can settle the wait.
         const outcome = await inProvider(async () => {
            const refused = await scratch.harness.shared.model.ModelService[method](uri, DocumentState.Linked).catch(
               (error: unknown) => error
            );
            left = builderListeners();
            return rethrow(refused);
         });

         expect(outcome).toBeInstanceOf(ReadLockWaitError);
         expect(left).toEqual(listeners);
         await scratch.harness.shared.model.ModelService.rebuild(uri);
         expect(capture.lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([]);
      }
   );

   it('leaves a recovery build another caller joins to settle once its own request is refused', async () => {
      const sync = scratch.harness.shared.workspace.VersionSyncService;
      const lock = scratch.harness.shared.workspace.WorkspaceLock;
      let joined!: Promise<void>;

      const outcome = await inProvider(() => {
         void lock.write(() => undefined);
         const refused = sync.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true });
         joined = runInReadLockScope(() => sync.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true }), undefined);
         return refused;
      });

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
      await joined;
   });

   it('logs no failure for the build of a document it opens and outlasts', async () => {
      await scratch.workspace.write('opened.domain', 'entity Opened {\n   a : string\n}\n');
      const opened = URI.file(scratch.workspace.resolve('opened.domain')).toString();
      const session = scratch.harness.shared.model.ModelService.createSession('form');
      await scratch.harness.shared.model.ModelService.ensureDocumentState(opened, DocumentState.Validated);
      // Changed on disk, so the open reads a text the parsed root does not hold, and builds it.
      await scratch.workspace.write('opened.domain', 'entity Opened {\n   b : string\n}\n');

      await inProvider(async () => {
         await session.open(opened);
         await new Promise(resolve => setTimeout(resolve, GRACE_MS * 3));
      });

      await scratch.harness.shared.model.ModelService.ensureDocumentState(opened, DocumentState.Validated);
      expect(capture.lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([]);
      await session.close(opened);
   });

   it('leaves a task free to wait for a build once the request has ended', async () => {
      let later!: Promise<unknown>;

      await inProvider(async () => {
         later = tick(5).then(() => scratch.harness.shared.model.ModelService.rebuild(uri));
      });

      expect(await later).toMatchObject({ uri });
   });

   it.each([
      ['rebuilds through the model service', () => scratch.harness.shared.model.ModelService.rebuild(uri)],
      [
         'requests a recovery build',
         () => scratch.harness.shared.workspace.VersionSyncService.requestRecoveryBuild(URI.parse(uri), { stillNeeded: () => true })
      ],
      [
         'rebuilds from a read nested in another read',
         () => inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri)).then(rethrow)
      ],
      [
         'reads the lock again, queued, while a write waits for it',
         () => {
            const lock = scratch.harness.shared.workspace.WorkspaceLock;
            void lock.write(() => undefined);
            return lock.read(() => 'inner');
         }
      ]
   ])('is refused when it %s', async (_title, wait) => {
      expect(await inProvider(wait)).toBeInstanceOf(ReadLockWaitError);
   });

   it('is refused when a handler without a required state rebuilds, which Langium runs as a queued read', async () => {
      const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.rebuild(uri), ReadPriority.Normal);

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
   });

   it('is refused when it waits for a state the document has not reached', async () => {
      const workspace = scratch.harness.shared.workspace;
      workspace.DocumentBuilder.resetToState(workspace.LangiumDocuments.getDocument(URI.parse(uri))!, DocumentState.Parsed);

      const outcome = await inProvider(() => scratch.harness.shared.model.ModelService.waitForDocumentState(uri, DocumentState.Linked));

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
      await scratch.harness.shared.model.ModelService.rebuild(uri);
   });

   it('waits for a builder state a running build reaches after the grace period', async () => {
      const { held, release } = holdNextBuild('test-hold-builder-state');
      const building = scratch.harness.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      await held;

      const waiting = inProvider(() => scratch.harness.shared.model.ModelService.waitForBuilderState(DocumentState.Validated));
      setTimeout(release, GRACE_MS * 3);

      await building;
      expect(await waiting).toBeUndefined();
   });

   it('is refused, and leaves no listener, when it waits for a text no build has parsed', async () => {
      const models = scratch.harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      texts++;
      await scratch.harness.shared.workspace.AstDocumentManager.update(uri, `entity Solo {\n   b${texts} : string\n}\n`, session.clientId);
      const listeners = builderListeners();
      let left: number[] = [];

      // Counted inside the request, before the build it queued can settle the wait.
      const outcome = await inProvider(async () => {
         const refused = await models.ensureDocumentState(uri, DocumentState.Linked).catch((error: unknown) => error);
         left = builderListeners();
         return rethrow(refused);
      });

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
      expect(left).toEqual(listeners);
      await models.rebuild(uri);
      await session.close(uri);
   });

   it('is refused when it writes through a client session', async () => {
      const models = scratch.harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);

      const outcome = await inProvider(() => session.update({ uri, model: 'entity Solo {\n   c : string\n}\n', baseVersion: 'any' }));

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
      // The refusal comes after its text was applied.
      await models.rebuild(uri);
      expect(scratch.harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText()).toContain('c : string');
      await session.close(uri);
   });

   it('is refused when it writes through a client session inside withOpen', async () => {
      const session = scratch.harness.shared.model.ModelService.createSession('form');

      const outcome = await inProvider(() =>
         session.withOpen(uri, () => session.update({ uri, model: 'entity Solo {\n   d : string\n}\n', baseVersion: 'any' }))
      );

      expect(outcome).toBeInstanceOf(ReadLockWaitError);
      await scratch.harness.shared.model.ModelService.rebuild(uri);
   });

   it("is refused when it deletes a document, and keeps the delete marked as its client's until the deletion build ends", async () => {
      const manager = scratch.harness.shared.workspace.AstDocumentManager;
      const outcome = await inProvider(async () => {
         const refused = await manager.delete(uri, 'client-1').catch((error: unknown) => error);
         return { refused, deleting: manager.isDeleting(uri), by: manager.attributeDeletion(uri) };
      });

      expect(outcome).toEqual({ refused: expect.any(ReadLockWaitError), deleting: true, by: 'client-1' });
      // The deletion build runs once the request has ended.
      await scratch.harness.shared.workspace.WorkspaceLock.read(() => undefined);
      expect(scratch.harness.shared.workspace.LangiumDocuments.hasDocument(URI.parse(uri))).toBe(false);
      await vi.waitFor(() => expect(manager.isDeleting(uri)).toBe(false));
   });

   it('keeps a change to a document recreated while its refused delete waits, and ends the deleting open', async () => {
      const manager = scratch.harness.shared.workspace.AstDocumentManager;
      const builder = scratch.harness.shared.workspace.DocumentBuilder;
      const session = scratch.harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      const refused = await inProvider(async () => {
         const deleting = manager.delete(uri, session.clientId).catch((error: unknown) => error);
         await vi.waitFor(() => expect(existsSync(scratch.workspace.resolve(FILE))).toBe(false));
         await scratch.workspace.write(FILE, 'entity Solo {\n   e : string\n}\n');
         void runInReadLockScope(() => builder.scheduleUpdate([URI.parse(uri)], []), undefined);
         return deleting;
      });

      expect(refused).toBeInstanceOf(ReadLockWaitError);
      await scratch.harness.shared.workspace.WorkspaceLock.write(() => undefined);
      await vi.waitFor(() => expect(manager.isDeleting(uri)).toBe(false));
      expect(scratch.harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      await scratch.harness.shared.model.ModelService.ensureDocumentState(uri);
      expect(scratch.harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText()).toContain('e : string');
   });

   it('keeps an open the deleting client makes after its refused delete', async () => {
      const manager = scratch.harness.shared.workspace.AstDocumentManager;
      const builder = scratch.harness.shared.workspace.DocumentBuilder;
      const textDocuments = scratch.harness.shared.workspace.TextDocuments;
      const session = scratch.harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      let reopened: Promise<unknown> | undefined;
      const refused = await inProvider(async () => {
         const deleting = manager.delete(uri, session.clientId).catch((error: unknown) => error);
         await vi.waitFor(() => expect(existsSync(scratch.workspace.resolve(FILE))).toBe(false));
         await scratch.workspace.write(FILE, 'entity Solo {\n   f : string\n}\n');
         void runInReadLockScope(() => builder.scheduleUpdate([URI.parse(uri)], []), undefined);
         const outcome = await deleting;
         // The client opens the document again while the request still runs.
         reopened = runInReadLockScope(() => session.open(uri), undefined).catch((error: unknown) => error);
         await vi.waitFor(() => expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(true));
         return outcome;
      });

      expect(refused).toBeInstanceOf(ReadLockWaitError);
      await reopened;
      await scratch.harness.shared.workspace.WorkspaceLock.write(() => undefined);
      await vi.waitFor(() => expect(manager.isDeleting(uri)).toBe(false));
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(true);
      await session.close(uri);
   });

   it('relinks a dependent when the release of the deleting open cancels the deletion build', async () => {
      const shared = scratch.harness.shared;
      const lock = shared.workspace.WorkspaceLock;
      const dependent = URI.file(scratch.workspace.resolve('dependent.domain'));
      await scratch.workspace.write('dependent.domain', 'entity Dependent {\n   s : Solo\n}\n');
      await shared.model.ModelService.rebuild(dependent.toString());
      const reference = (): { ref?: unknown; error?: unknown } => {
         const root = shared.workspace.LangiumDocuments.getDocument(dependent)?.parseResult.value;
         return isDomainModel(root) && isEntity(root.declarations[0]) ? root.declarations[0].fields[0].type.declared : {};
      };
      expect(reference().ref).toBeDefined();
      const session = shared.model.ModelService.createSession('form');
      await session.open(uri);
      const tokens: CancellationToken[] = [];
      const write = lock.write.bind(lock);
      const writes = vi.spyOn(lock, 'write').mockImplementation(action =>
         write(token => {
            tokens.push(token);
            return action(token);
         })
      );
      const refused = await inProvider(async () => {
         const outcome = await shared.workspace.AstDocumentManager.delete(uri, session.clientId).catch((error: unknown) => error);
         // The request goes on, so the release of the last open queues behind the deletion build and cancels it.
         // The release decides from the file on disk before it queues its write, so allow a slow file system.
         await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2), { timeout: 10_000 });
         return outcome;
      });
      await vi.waitFor(() => expect(tokens).toHaveLength(2));

      expect(refused).toBeInstanceOf(ReadLockWaitError);
      expect(tokens[0].isCancellationRequested).toBe(true);
      await vi.waitFor(() => expect(shared.workspace.AstDocumentManager.isDeleting(uri)).toBe(false));
      await lock.write(() => undefined);
      await shared.model.ModelService.ensureDocumentState(dependent.toString(), DocumentState.Validated);
      expect(shared.workspace.LangiumDocuments.hasDocument(URI.parse(uri))).toBe(false);
      expect(reference()).toEqual(expect.objectContaining({ ref: undefined, error: expect.anything() }));
   });

   it("waits past the grace period for a rebuild on another server, whose build holds off nothing in this one's lock", async () => {
      const other = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, 'entity Solo {\n   a : string\n}\n'));
      try {
         const otherUri = URI.file(other.workspace.resolve(FILE)).toString();
         const gate = new Deferred<void>();
         let building = false;
         const holding = other.harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Parsed, () => {
            building = true;
            return gate.promise;
         });
         const outcome = inProvider(() => other.harness.shared.model.ModelService.rebuild(otherUri).then(() => 'rebuilt'));
         await vi.waitFor(() => expect(building).toBe(true));
         // The other server's build runs past this server's grace period.
         await new Promise(resolve => setTimeout(resolve, 3 * GRACE_MS));
         holding.dispose();
         gate.resolve();

         expect(await outcome).toBe('rebuilt');
      } finally {
         await other.dispose();
      }
   });
});

/** Rethrow an error `inProvider` settled to, so the outer read sees it. */
function rethrow(outcome: unknown): unknown {
   if (outcome instanceof Error) {
      throw outcome;
   }
   return outcome;
}
