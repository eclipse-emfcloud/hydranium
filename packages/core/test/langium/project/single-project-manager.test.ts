/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type LangiumDocument, type LangiumDocuments, URI } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { SingleProjectManager } from '../../../src/langium/project/single-project-manager.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

const URI_A = URI.parse('file:///workspace/Foo.a');
const URI_B = URI.parse('file:///workspace/Bar.a');
const URI_C = URI.parse('file:///other/Baz.a');

function fakeDocs(uris: URI[]): LangiumDocuments {
   return {
      get all() {
         return uris.map(uri => ({ uri }) as unknown as LangiumDocument);
      }
   } as unknown as LangiumDocuments;
}

function fakeServices(uris: URI[]): ServerSharedServicesMinimal {
   return makeNoopSharedServices({ workspace: { LangiumDocuments: fakeDocs(uris) } });
}

describe('SingleProjectManager', () => {
   it('ready resolves immediately', async () => {
      const mgr = new SingleProjectManager(fakeServices([]));
      await expect(mgr.ready).resolves.toBeUndefined();
   });

   it('discoverProjects is a no-op', async () => {
      const mgr = new SingleProjectManager(fakeServices([]));
      await mgr.discoverProjects();
      expect(mgr.getProjects().map(p => p.id)).toEqual([SingleProjectManager.WORKSPACE_PROJECT_ID]);
   });

   it('isProjectDescriptor always returns false', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A]));
      expect(mgr.isProjectDescriptor(URI_A)).toBe(false);
      expect(mgr.isProjectDescriptor('file:///anything')).toBe(false);
   });

   it('getProject returns the synthetic workspace project for any URI', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A]));
      expect(mgr.getProject(URI_A)?.id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
      expect(mgr.getProject(URI_B)?.id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
      expect(mgr.getProject(URI_C)?.id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
      expect(mgr.getProject('file:///never-loaded.a')?.id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
   });

   it('getProjectById matches only the synthetic workspace id', () => {
      const mgr = new SingleProjectManager(fakeServices([]));
      expect(mgr.getProjectById(SingleProjectManager.WORKSPACE_PROJECT_ID)?.id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
      expect(mgr.getProjectById('something-else')).toBeUndefined();
   });

   it('getProjects returns a single-element list', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A, URI_B]));
      const projects = mgr.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(SingleProjectManager.WORKSPACE_PROJECT_ID);
   });

   it('getProjectUris returns every workspace URI for the synthetic project', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A, URI_B, URI_C]));
      const uris = mgr.getProjectUris(SingleProjectManager.WORKSPACE_PROJECT_ID).map(u => u.toString());
      expect(uris).toEqual([URI_A.toString(), URI_B.toString(), URI_C.toString()]);
   });

   it('getProjectUris returns [] for any other id', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A, URI_B]));
      expect(mgr.getProjectUris('does-not-exist')).toEqual([]);
   });

   it('getVisibleProjects is self-only — combined with single-project ownership = everything sees everything', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A, URI_B]));
      expect(mgr.getVisibleProjects(SingleProjectManager.WORKSPACE_PROJECT_ID)).toEqual([SingleProjectManager.WORKSPACE_PROJECT_ID]);
      expect(mgr.getVisibleProjects('does-not-exist')).toEqual([]);
   });

   it('isVisible: synthetic project sees itself per selfVisible', () => {
      const mgr = new SingleProjectManager(fakeServices([]));
      const id = SingleProjectManager.WORKSPACE_PROJECT_ID;
      expect(mgr.isVisible(id, id)).toBe(false); // default selfVisible=false
      expect(mgr.isVisible(id, id, true)).toBe(true);
      expect(mgr.isVisible(id, 'other')).toBe(false);
      expect(mgr.isVisible('does-not-exist', id)).toBe(false);
   });

   it('isSingleProject is always true', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A, URI_B]));
      expect(mgr.isSingleProject()).toBe(true);
   });

   it('isUnqualifiedProjectReference is always true for any URI', () => {
      const mgr = new SingleProjectManager(fakeServices([URI_A]));
      expect(mgr.isUnqualifiedProjectReference(URI_A)).toBe(true);
      expect(mgr.isUnqualifiedProjectReference('file:///never-loaded.a')).toBe(true);
   });

   it('WORKSPACE_PROJECT_ID is the @workspace sentinel', () => {
      // Pins the literal: a mutant emptying it ("") would let it collide with a
      // descriptor-derived id and would not match the synthetic project below.
      expect(SingleProjectManager.WORKSPACE_PROJECT_ID).toBe('@workspace');
      const mgr = new SingleProjectManager(fakeServices([]));
      expect(mgr.getProject(URI_A)?.id).toBe('@workspace');
   });

   it('isVisible: non-workspace source is never visible even to itself', () => {
      // Kills the `if (false)` mutant of isVisible's workspace-id guard: a foreign
      // source must short circuit to false before the self-equality branch can
      // return selfVisible.
      const mgr = new SingleProjectManager(fakeServices([]));
      expect(mgr.isVisible('other', 'other', true)).toBe(false);
   });

   it('onProjectsChanged returns a safe disposable that never fires the listener', () => {
      const mgr = new SingleProjectManager(fakeServices([]));
      let fired = 0;
      const disposable = mgr.onProjectsChanged(() => fired++);
      // No-op dispose should not throw.
      disposable.dispose();
      expect(fired).toBe(0);
   });
});
