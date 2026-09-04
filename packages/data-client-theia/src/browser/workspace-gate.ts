/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type WorkspaceService } from '@theia/workspace/lib/browser';

/**
 * Resolve once a workspace is open (one or more roots present). Resolves
 * immediately if a workspace is already open, otherwise on the first
 * `onWorkspaceChanged` that reports roots — the listener disposes itself.
 *
 * The common Theia gate for a data-server head: the model-server only starts
 * once the LSP launches for a workspace, so connecting earlier would hang on
 * port discovery. Pass the returned promise as
 * `OpenChannelConnectionOptions.whenReady`.
 */
export function whenWorkspaceOpen(workspaceService: WorkspaceService): Promise<void> {
   const roots = workspaceService.tryGetRoots();
   if (roots && roots.length > 0) {
      return Promise.resolve();
   }
   return new Promise<void>(resolve => {
      const disposable = workspaceService.onWorkspaceChanged(changedRoots => {
         if (changedRoots && changedRoots.length > 0) {
            disposable.dispose();
            resolve();
         }
      });
   });
}
