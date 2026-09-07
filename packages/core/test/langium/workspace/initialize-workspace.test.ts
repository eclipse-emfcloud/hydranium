/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { Deferred } from '@hydranium/protocol';
import type { BuildOptions, LangiumDocument } from '@hydranium/langium';
import type { InitializeParams, InitializedParams, WorkspaceFolder } from 'vscode-languageserver';
import { URI } from '@hydranium/langium';
import type { ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';
import {
   buildWorkspaceProgrammatically,
   initializeWorkspaceProgrammatically
} from '../../../src/langium/workspace/initialize-workspace.js';

/** Captures the lifecycle calls the seam drives, in order. */
class FakeWorkspaceManager {
   readonly events: string[] = [];
   capturedInitializeParams?: InitializeParams;
   /** Resolves `initialized()`; replaceable so a test can hold the build open. */
   initializedGate = Promise.resolve();

   initialize(params: InitializeParams): void {
      this.events.push('initialize');
      this.capturedInitializeParams = params;
   }

   async initialized(_params: InitializedParams): Promise<void> {
      this.events.push('initialized');
      await this.initializedGate;
   }
}

function makeServices(manager: FakeWorkspaceManager): ServerSharedServicesMinimal {
   return makeNoopSharedServices({ workspace: { WorkspaceManager: manager } });
}

function workspaceFolders(manager: FakeWorkspaceManager): readonly WorkspaceFolder[] | null | undefined {
   return manager.capturedInitializeParams?.workspaceFolders;
}

describe('initializeWorkspaceProgrammatically', () => {
   it('normalizes a single path string to one workspace folder and runs initialize before initialized', async () => {
      const manager = new FakeWorkspaceManager();
      await initializeWorkspaceProgrammatically(makeServices(manager), '/abs/workspace/root');
      expect(manager.events).toEqual(['initialize', 'initialized']);
      // `path.resolve` around the expectation, because that is what the code
      // does to a string entry: a leading `/` is drive-relative on Windows, so
      // the bare literal names a different location there than the one passed.
      expect(workspaceFolders(manager)).toEqual([{ uri: URI.file(path.resolve('/abs/workspace/root')).toString(), name: 'root' }]);
   });

   it('accepts an array mixing path strings and URIs, naming each folder by its basename', async () => {
      const manager = new FakeWorkspaceManager();
      await initializeWorkspaceProgrammatically(makeServices(manager), ['/ws/alpha', URI.file('/ws/beta')]);
      // Only the STRING entry is resolved; the URI entry is passed through as
      // given, which is the distinction this case exists to hold.
      expect(workspaceFolders(manager)).toEqual([
         { uri: URI.file(path.resolve('/ws/alpha')).toString(), name: 'alpha' },
         { uri: URI.file('/ws/beta').toString(), name: 'beta' }
      ]);
   });

   it('does not resolve until initialized settles (awaits the build gate)', async () => {
      const manager = new FakeWorkspaceManager();
      const gate = new Deferred<void>();
      manager.initializedGate = gate.promise;
      let resolved = false;
      const done = initializeWorkspaceProgrammatically(makeServices(manager), '/ws').then(() => {
         resolved = true;
      });
      // Let the seam reach the awaited `initialized()`; it must still be pending.
      await Promise.resolve();
      expect(resolved).toBe(false);
      gate.resolve();
      await done;
      expect(resolved).toBe(true);
   });
});

describe('buildWorkspaceProgrammatically', () => {
   it('initializes then builds every registered document with validation', async () => {
      const manager = new FakeWorkspaceManager();
      const docA = { id: 'a' } as unknown as LangiumDocument;
      const docB = { id: 'b' } as unknown as LangiumDocument;
      const buildCalls: Array<{ documents: readonly LangiumDocument[]; options?: BuildOptions }> = [];
      const services = makeNoopSharedServices({
         workspace: {
            WorkspaceManager: manager,
            LangiumDocuments: { all: { toArray: () => [docA, docB] } },
            DocumentBuilder: {
               build: (documents: readonly LangiumDocument[], options?: BuildOptions) => {
                  manager.events.push('build');
                  buildCalls.push({ documents, options });
                  return Promise.resolve();
               }
            }
         }
      });

      await buildWorkspaceProgrammatically(services, '/ws');

      // Init runs first, then the explicit build-all.
      expect(manager.events).toEqual(['initialize', 'initialized', 'build']);
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0].documents).toEqual([docA, docB]);
      expect(buildCalls[0].options).toEqual({ validation: true });
   });
});
