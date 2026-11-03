/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   DefaultVersionSyncService,
   initializeWorkspaceProgrammatically,
   type RecoveryBuildRequest,
   type ServerSharedServices
} from '@hydranium/core';
import { DefaultHydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { disposeScratchWorkspace, makeScratchWorkspace, settleServer } from '@hydranium/core/testing/node';
import { Deferred, DocumentState, URI } from '@hydranium/langium';
import { tick } from '@hydranium/protocol/testing';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { OrderFlowProjectManager } from '../src/language-server/order-flow-project-manager.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices } from './order-flow-harness.js';

/** A change stays pending for the whole test unless something flushes it. */
const HELD_CHANGES = {
   lsp: {
      DocumentUpdateHandler: (shared: ServerSharedServices) =>
         new DefaultHydraniumDocumentUpdateHandler(shared, { debounceMs: 60_000, bypassNonLanguageClientChanges: false })
   }
};

/** A document no file backs, for the stages that never build it. */
const MEMORY_URI = 'file:///settle-server/held.domain';
const CLIENT_ID = 'settle-server-test';

/** Records when `settling` resolves into `order`, for an ordering assertion. */
function recordSettle(settling: Promise<void>, order: string[]): Promise<void> {
   return settling.then(() => {
      order.push('settled');
   });
}

/** Stage a change of `uri` in the update handler, as an editor's keystroke would. */
function stageChange(shared: ServerSharedServices, uri: URI): void {
   const handler = shared.lsp.DocumentUpdateHandler;
   if (!(handler instanceof DefaultHydraniumDocumentUpdateHandler)) {
      throw new Error('the update handler is not the one HELD_CHANGES binds');
   }
   handler.didChangeContent({ document: TextDocument.create(uri.toString(), 'domain', 2, '') });
}

/** Whether `uri` reached `Validated` in a build that ran after this call. */
function watchValidated(shared: ServerSharedServices, uri: URI): () => boolean {
   let validated = false;
   shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, documents => {
      validated ||= documents.some(document => document.uri.toString() === uri.toString());
   });
   return () => validated;
}

/** Open and close `MEMORY_URI`, which hands its release to the `DocumentReleaseHandler` slot. */
function openAndRelease(shared: ServerSharedServices): void {
   const documents = shared.workspace.TextDocuments;
   documents.notifyDidOpenTextDocument({ textDocument: { uri: MEMORY_URI, languageId: 'domain', version: 1, text: '' } }, CLIENT_ID);
   documents.notifyDidCloseTextDocument({ textDocument: { uri: MEMORY_URI } }, CLIENT_ID);
}

/** A release handler whose releases settle only once `hold` resolves. */
function heldReleases(
   hold: Deferred<void>,
   order: string[]
): { workspace: { DocumentReleaseHandler: () => { didReleaseDocument: () => Promise<void> } } } {
   const handler = { didReleaseDocument: () => hold.promise.then(() => void order.push('released')) };
   return { workspace: { DocumentReleaseHandler: () => handler } };
}

describe('settleServer', () => {
   it('resolves for services whose workspace was never initialized', async () => {
      const harness = makeServices();
      await expect(settleServer(harness.shared, 60_000)).resolves.toBeUndefined();
   });

   it('gives up without throwing once a write stays stuck past its bound, and says so on stderr', async () => {
      const harness = makeServices();
      const release = new Deferred<void>();
      const stuck = harness.shared.workspace.WorkspaceLock.write(() => release.promise);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
         await expect(settleServer(harness.shared, 50)).resolves.toBeUndefined();
         expect(stderr).toHaveBeenCalledWith('[hydranium] the server did not settle within 50 ms\n');
      } finally {
         stderr.mockRestore();
         release.resolve();
         await stuck;
      }
   });
});

describe('settleServer once it gave up', () => {
   it('starts no further pass when the build it waited on ends', async () => {
      const hold = new Deferred<void>();
      const harness = makeServices();
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-gave-up-' });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
         const reached = new Deferred<void>();
         harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Linked, async () => {
            reached.resolve();
            await hold.promise;
         });
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
         const build = harness.shared.workspace.DocumentBuilder.build([document]);
         await reached.promise;
         await settleServer(harness.shared, 50);
         const flushes = vi.spyOn(harness.shared.lsp.DocumentUpdateHandler, 'flushPending');

         hold.resolve();
         await build;
         await tick();

         expect(flushes).not.toHaveBeenCalled();
      } finally {
         stderr.mockRestore();
         hold.resolve();
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   });
});

describe('settleServer waits for each stage of the server work', () => {
   it('flushes a debounced change and resolves once its build ends', async () => {
      const harness = makeServices({ extraSharedModules: [HELD_CHANGES] });
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-flush-' });
      try {
         await initializeWorkspaceProgrammatically(harness.shared, workspace.root);
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         const validated = watchValidated(harness.shared, uri);
         stageChange(harness.shared, uri);

         await settleServer(harness.shared, 60_000);

         expect(validated()).toBe(true);
      } finally {
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   }, 60_000);

   it('started during the workspace initialization, waits for a change the initialization holds back', async () => {
      // Services first, so a throw from them leaves no directory behind.
      const harness = makeServices({ extraSharedModules: [HELD_CHANGES] });
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-init-' });
      const releaseInit = new Deferred<void>();
      try {
         // Holds the initial build, so the change's build queues behind it while the settle starts.
         const reachedBarrier = new Deferred<void>();
         let barrierArmed = true;
         harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Linked, async () => {
            if (!barrierArmed) {
               return;
            }
            barrierArmed = false;
            reachedBarrier.resolve();
            await releaseInit.promise;
         });
         const initialization = initializeWorkspaceProgrammatically(harness.shared, workspace.root);
         await reachedBarrier.promise;
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         const validated = watchValidated(harness.shared, uri);
         stageChange(harness.shared, uri);

         const settling = settleServer(harness.shared, 60_000);
         releaseInit.resolve();
         await initialization;
         await settling;

         expect(validated()).toBe(true);
      } finally {
         // A failed assertion before the release would otherwise hold the build, and the settle with it.
         releaseInit.resolve();
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   }, 60_000);

   it('waits for a release handed to the release handler', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      const harness = makeServices({ extraSharedModules: [heldReleases(hold, order)] });
      try {
         openAndRelease(harness.shared);
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await settling;

         expect(order).toEqual(['released', 'settled']);
      } finally {
         hold.resolve();
      }
   }, 60_000);

   it('waits for a recovery build that has not queued its write yet', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      // Holds the build between the recovery's lock read and its write, where no lock covers it.
      class HeldVersionSyncService extends DefaultVersionSyncService {
         protected override scheduleBatch(_uri: URI, _batch: readonly RecoveryBuildRequest[]): Promise<void> {
            return hold.promise.then(() => void order.push('built'));
         }
      }
      const harness = makeServices({
         extraSharedModules: [{ workspace: { VersionSyncService: (shared: ServerSharedServices) => new HeldVersionSyncService(shared) } }]
      });
      try {
         const recovery = harness.shared.workspace.VersionSyncService.requestRecoveryBuild(URI.parse(MEMORY_URI), {
            stillNeeded: () => true
         });
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await settling;
         await recovery;

         expect(order).toEqual(['built', 'settled']);
      } finally {
         hold.resolve();
      }
   }, 60_000);

   it('waits for a recovery build whose lock read runs in the same batch as its own', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      const harness = makeServices();
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-batch-' });
      try {
         await initializeWorkspaceProgrammatically(harness.shared, workspace.root);
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         // Holds back both reads, so the lock runs them in one batch.
         const write = harness.shared.workspace.WorkspaceLock.write(() => hold.promise);
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         const recovery = harness.shared.workspace.VersionSyncService.requestRecoveryBuild(uri, { stillNeeded: () => true });
         const built = recovery.then(() => void order.push('built'));
         hold.resolve();
         await write;
         await settling;
         await built;

         expect(order).toEqual(['built', 'settled']);
      } finally {
         hold.resolve();
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   }, 60_000);

   it('waits for a deferred member relink', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      class HeldRelinkProjectManager extends OrderFlowProjectManager {
         override memberRelinkSettled(): Promise<void> {
            return hold.promise.then(() => void order.push('relinked'));
         }
      }
      const harness = makeServices({
         extraSharedModules: [
            { workspace: { ProjectManager: (services: OrderFlowSharedServices) => new HeldRelinkProjectManager(services) } }
         ]
      });
      try {
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await settling;

         expect(order[0]).toBe('relinked');
         expect(order.at(-1)).toBe('settled');
      } finally {
         hold.resolve();
      }
   }, 60_000);

   it('waits for a build that runs outside the workspace lock', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      const harness = makeServices();
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-unlocked-' });
      try {
         const reached = new Deferred<void>();
         harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Linked, async () => {
            reached.resolve();
            await hold.promise;
         });
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
         const build = harness.shared.workspace.DocumentBuilder.build([document]).then(() => void order.push('built'));
         await reached.promise;
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await build;
         await settling;

         expect(order).toEqual(['built', 'settled']);
      } finally {
         hold.resolve();
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   }, 60_000);

   it('runs its stages again for a recovery build that a build started before it requests', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      const harness = makeServices();
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-settle-unlocked-recovery-' });
      try {
         const reached = new Deferred<void>();
         const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain));
         const writeHold = new Deferred<void>();
         let write: Promise<void> | undefined;
         let recovered: Promise<void> | undefined;
         harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, async () => {
            reached.resolve();
            await hold.promise;
            // Keeps the recovery's read queued past the build's end, so the build's end alone does not show it.
            write ??= harness.shared.workspace.WorkspaceLock.write(() => writeHold.promise);
            recovered ??= harness.shared.workspace.VersionSyncService.requestRecoveryBuild(uri, { stillNeeded: () => true }).then(
               () => void order.push('recovered')
            );
         });
         const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
         const build = harness.shared.workspace.DocumentBuilder.build([document], { validation: true });
         await reached.promise;
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await build;
         await tick();
         writeHold.resolve();
         await write;
         await settling;
         await recovered;

         expect(order).toEqual(['recovered', 'settled']);
      } finally {
         hold.resolve();
         await disposeScratchWorkspace(workspace, harness.shared);
      }
   }, 60_000);

   it('waits for a running workspace lock write', async () => {
      const order: string[] = [];
      const hold = new Deferred<void>();
      const harness = makeServices();
      const write = harness.shared.workspace.WorkspaceLock.write(() => hold.promise.then(() => void order.push('written')));
      try {
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         hold.resolve();
         await settling;

         expect(order).toEqual(['written', 'settled']);
      } finally {
         hold.resolve();
         await write;
      }
   }, 60_000);

   it('runs its stages again for a release that starts while a later stage waits', async () => {
      const order: string[] = [];
      const releaseHold = new Deferred<void>();
      const writeHold = new Deferred<void>();
      const harness = makeServices({ extraSharedModules: [heldReleases(releaseHold, order)] });
      const write = harness.shared.workspace.WorkspaceLock.write(() => writeHold.promise);
      try {
         const settling = recordSettle(settleServer(harness.shared, 60_000), order);
         await tick();
         // The settle waits on the write at this point, past the stage that waits for releases.
         openAndRelease(harness.shared);
         writeHold.resolve();
         await write;
         await tick();
         releaseHold.resolve();
         await settling;

         expect(order).toEqual(['released', 'settled']);
      } finally {
         writeHold.resolve();
         releaseHold.resolve();
      }
   }, 60_000);
});
