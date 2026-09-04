/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Emitter } from '@theia/core';
import { type WorkspaceService } from '@theia/workspace/lib/browser';
import { whenWorkspaceOpen } from '../src/browser/workspace-gate';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Minimal stand-in exposing only the surface `whenWorkspaceOpen` reads. */
class FakeWorkspaceService {
   roots: object[] = [];
   readonly onWorkspaceChangedEmitter = new Emitter<object[]>();
   tryGetRoots(): object[] {
      return this.roots;
   }
   get onWorkspaceChanged(): Emitter<object[]>['event'] {
      return this.onWorkspaceChangedEmitter.event;
   }
}

describe('whenWorkspaceOpen', () => {
   it('resolves immediately when a workspace is already open', async () => {
      const workspace = new FakeWorkspaceService();
      workspace.roots = [{}];
      await expect(whenWorkspaceOpen(workspace as unknown as WorkspaceService)).resolves.toBeUndefined();
   });

   it('resolves on the first workspace change that reports roots, ignoring empty changes', async () => {
      const workspace = new FakeWorkspaceService();
      let resolved = false;
      const gate = whenWorkspaceOpen(workspace as unknown as WorkspaceService).then(() => {
         resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);

      workspace.onWorkspaceChangedEmitter.fire([]);
      await flush();
      expect(resolved).toBe(false);

      workspace.onWorkspaceChangedEmitter.fire([{}]);
      await gate;
      expect(resolved).toBe(true);
   });
});
