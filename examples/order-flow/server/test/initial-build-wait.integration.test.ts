/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A wait for `Validated` armed while the initial workspace build runs.
 *
 * The initial build does not validate (Langium's `initialBuildOptions` leave
 * `validation` unset), so it runs its `Validated` phase over no documents, and
 * Langium sends no `onBuildPhase` notification for an empty phase. A wait armed
 * before that point cannot tell the build will leave its document behind, so
 * only the end of the build can re-queue it. A phase listener holds the build
 * at `Linked` while the wait is armed, so the order is constructed, not raced.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { makeScratchWorkspace } from '@hydranium/core/testing/node';
import { Deferred, DocumentState, URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices } from './order-flow-harness.js';

describe('a wait for Validated armed during the initial workspace build', () => {
   it('resolves once that build ends, although the build validates nothing', async () => {
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-initial-wait-' });
      try {
         const harness = makeServices();
         const builder = harness.shared.workspace.DocumentBuilder;
         const reachedBarrier = new Deferred<void>();
         const releaseInit = new Deferred<void>();
         let barrierArmed = true;
         builder.onBuildPhase(DocumentState.Linked, async () => {
            if (!barrierArmed) {
               return;
            }
            barrierArmed = false;
            reachedBarrier.resolve();
            await releaseInit.promise;
         });

         const initialization = initializeWorkspaceProgrammatically(harness.shared, workspace.root);
         await reachedBarrier.promise;

         const processUri = URI.file(path.join(workspace.root, WORKSPACE_FILES.fulfillmentProcess));
         let validated = false;
         void builder.waitUntil(DocumentState.Validated, processUri).then(() => (validated = true));
         releaseInit.resolve();
         await initialization;

         // Bounded, so a wait nothing will resolve fails instead of hanging.
         await waitFor(() => validated, { timeoutMs: 5_000, message: 'the wait armed during the initial build never resolved' });
         expect(harness.shared.workspace.LangiumDocuments.getDocument(processUri)?.state).toBe(DocumentState.Validated);
      } finally {
         workspace.dispose();
      }
   }, 30_000);
});

/**
 * A wait for `Validated` whose build ends early, and no build follows. A lock
 * write cancels the build running when it is queued, and a write that builds
 * nothing, such as a last-close revert that finds the document reopened, leaves
 * the wait with no build to carry its document; so does a build that fails. A
 * phase listener holds the build at `Linked` while the wait is armed.
 */
describe('a wait for Validated whose build ends before validating', () => {
   async function boot(): Promise<{
      harness: ReturnType<typeof makeServices>;
      processUri: URI;
      dispose: () => void;
   }> {
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-cut-wait-' });
      const harness = makeServices();
      await initializeWorkspaceProgrammatically(harness.shared, workspace.root);
      const processUri = URI.file(path.join(workspace.root, WORKSPACE_FILES.fulfillmentProcess));
      return { harness, processUri, dispose: () => workspace.dispose() };
   }

   it.each([
      ['a lock write that builds nothing cancels it', 'cancel'],
      ['it fails', 'fail']
   ] as const)(
      'resolves when %s',
      async (_name, ending) => {
         const { harness, processUri, dispose } = await boot();
         try {
            const builder = harness.shared.workspace.DocumentBuilder;
            const reachedBarrier = new Deferred<void>();
            const release = new Deferred<void>();
            let barrierArmed = true;
            builder.onBuildPhase(DocumentState.Linked, async () => {
               if (!barrierArmed) {
                  return;
               }
               barrierArmed = false;
               reachedBarrier.resolve();
               await release.promise;
               if (ending === 'fail') {
                  throw new Error('the build failed');
               }
            });

            const building = builder.scheduleUpdate([processUri], []).catch(() => undefined);
            await reachedBarrier.promise;
            let validated = false;
            void builder.waitUntil(DocumentState.Validated, processUri).then(() => (validated = true));
            if (ending === 'cancel') {
               void harness.shared.workspace.WorkspaceLock.write(() => undefined);
            }
            release.resolve();
            await building;

            // Bounded, so a wait nothing will resolve fails instead of hanging.
            await waitFor(() => validated, { timeoutMs: 5_000, message: 'the wait on the build that ended early never resolved' });
            expect(harness.shared.workspace.LangiumDocuments.getDocument(processUri)?.state).toBe(DocumentState.Validated);
         } finally {
            dispose();
         }
      },
      30_000
   );
});
