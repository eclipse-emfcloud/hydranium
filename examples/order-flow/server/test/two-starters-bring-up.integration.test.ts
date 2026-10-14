/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Two starters on one services tree with no LSP head bring the workspace up
 * once.
 *
 * Each starter names the workspace. A second initialisation would cancel the
 * first one's build, reject `workspaceInitialized` and leave every document
 * unindexed, while both starters still report that they started.
 */

import { DocumentState } from '@hydranium/langium';
import { startSocketServer } from '@hydranium/core/node';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_ROOT, makeServices } from './order-flow-harness.js';

let workspace: ScratchWorkspace | undefined;
const closers: Array<() => void> = [];

afterEach(() => {
   for (const close of closers.splice(0)) {
      close();
   }
   workspace?.dispose();
   workspace = undefined;
});

describe('two socket starters without an LSP head', () => {
   it('bring the workspace up once and index every document', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-two-starters-' });
      const { shared } = makeServices();
      const servers = ['one', 'two'].map(logTag =>
         startSocketServer({ shared, workspace: workspace?.root, port: 0, logTag }, () => ({ dispose: () => undefined }))
      );
      closers.push(...servers.map(server => () => server.close()));
      await Promise.all(servers.map(server => server.started));

      const initialized = await shared.workspace.WorkspaceManager.workspaceInitialized.then(
         () => 'resolved',
         () => 'rejected'
      );
      const unindexed = shared.workspace.LangiumDocuments.all
         .filter(document => document.state < DocumentState.IndexedReferences)
         .map(document => document.uri.toString())
         .toArray();
      expect({ initialized, unindexed }).toEqual({ initialized: 'resolved', unindexed: [] });
   }, 30_000);
});
