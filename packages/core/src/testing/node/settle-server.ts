/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LspServerSharedServices } from '../../lsp/shared-module.js';
import type { ScratchWorkspace } from './scratch-workspace.js';

/**
 * Delete `workspace` once {@link settleServer} says `shared` reads none of
 * it, and delete it even when the settle throws. Either may be `undefined`,
 * for a teardown whose setup failed before creating it.
 */
export async function disposeScratchWorkspace(
   workspace: ScratchWorkspace | undefined,
   shared: LspServerSharedServices | undefined
): Promise<void> {
   try {
      if (shared) {
         await settleServer(shared);
      }
   } finally {
      workspace?.dispose();
   }
}

/**
 * Resolve once the server reads no file for work a test started: no debounced
 * change, handed-over release, recovery build or deferred member relink is
 * pending and no build runs.
 * Repeats while a pass saw a build or release start, since each can start the
 * others. A release still waiting out its grace is not waited for.
 *
 * Await it before deleting a scratch workspace the server was initialized
 * over, or a build still reading it logs ENOENT.
 *
 * Gives up after `timeoutMs` without throwing, so a write a failed test left
 * stuck still lets the teardown delete and the test report its own error.
 * The default is short so several settles fit in one test or hook timeout.
 * A real settle takes milliseconds.
 */
export async function settleServer(shared: LspServerSharedServices, timeoutMs = 1_000): Promise<void> {
   const workspace = shared.workspace;
   let started = 0;
   const start = (): void => {
      started++;
   };
   const builds = workspace.DocumentBuilder.onUpdate(start);
   const releases = workspace.TextDocuments.onDidReleaseDocument(start);
   let gaveUp = false;
   const settle = async (): Promise<void> => {
      // Once given up, the workspace may be gone, so no further pass starts a build over it.
      for (let seen = -1, building = false; !gaveUp && (seen !== started || building);) {
         seen = started;
         shared.lsp.DocumentUpdateHandler.flushPending();
         await workspace.TextDocuments.releasesSettled();
         // A flushed change waits for `ready`, which settles inside the initialization's write.
         // So its build queues before this read, and the lock runs queued writes first.
         await workspace.WorkspaceLock.read(() => undefined);
         // Work that queues its write from a read of the same batch runs after it, so it is awaited here.
         await workspace.VersionSyncService.recoveryBuildsSettled();
         await workspace.ProjectManager.memberRelinkSettled();
         // A build that started before the listeners fires no event, so the work it starts needs another pass.
         const running = workspace.DocumentBuilder.activeBuild;
         building = running !== undefined;
         await running;
      }
   };
   let timer: ReturnType<typeof setTimeout> | undefined;
   const expired = new Promise<'expired'>(resolve => {
      timer = setTimeout(() => {
         gaveUp = true;
         resolve('expired');
      }, timeoutMs);
   });
   try {
      if ((await Promise.race([settle(), expired])) === 'expired') {
         process.stderr.write(`[hydranium] the server did not settle within ${timeoutMs} ms\n`);
      }
   } finally {
      clearTimeout(timer);
      builds.dispose();
      releases.dispose();
   }
}
