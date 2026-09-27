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
