/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { beforeEach, describe, expect, it } from 'vitest';
import {
   type DocumentBuilder,
   type DocumentUpdateListener,
   type FileSystemProvider,
   type LangiumDocument,
   type LangiumDocuments,
   URI,
   UriUtils
} from '@hydranium/langium';
import { Disposable } from 'vscode-languageserver';
import { type Logger, type Project, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import { AbstractProjectManager } from '../../../src/langium/project/abstract-project-manager.js';
import type { ProjectChangeEvent } from '../../../src/langium/project/project-change-event.js';
import { makeCapturingLogger, makeFakeAstNode, makeFakeDocument, makeNoopSharedServices } from '../../../src/testing/index.js';

// ============================================================
// Test fixtures
// ============================================================

const URI_DESCRIPTOR_A = URI.parse('file:///workspace/projA/project.a');
const URI_DESCRIPTOR_B = URI.parse('file:///workspace/projB/project.a');
const URI_MEMBER_A1 = URI.parse('file:///workspace/projA/Element1.a');
const URI_MEMBER_A2 = URI.parse('file:///workspace/projA/Element2.a');
const URI_MEMBER_B1 = URI.parse('file:///workspace/projB/Element1.a');
const URI_OUTSIDE = URI.parse('file:///workspace/other/Stranger.a');

const isDescriptorPredicate = (uri: URI | string): boolean => {
   const s = typeof uri === 'string' ? uri : uri.toString();
   return s.endsWith('/project.a');
};

interface FakeDescriptor {
   id: string;
   version?: string;
   dependencies?: readonly string[];
   referenceName?: string;
}

function fakeDocument(uri: URI): LangiumDocument {
   return makeFakeDocument(uri, makeFakeAstNode({ $type: 'Test' }));
}

interface Stubs {
   fileSystemProvider: FileSystemProvider;
   langiumDocuments: LangiumDocuments;
   documentBuilder: DocumentBuilder;
   logger: Logger;
   // Stand-in for the framework's HydraniumWorkspaceManager — only `wsRelativePath`
   // is exercised by the change-logging path. Returns `<parentDir>/<file>` so the
   // asserted log lines are deterministic (e.g. `projA/project.a`).
   workspaceManager: { wsRelativePath: (uri: URI | string) => string };
   triggerBuildUpdate: (changed: URI[], deleted: URI[]) => Promise<void>;
   logs: { level: string; message: string }[];
   knownDocuments: URI[];
}

function makeStubs(knownDocuments: URI[] = []): Stubs {
   const updateListeners: DocumentUpdateListener[] = [];
   const { logger, lines: logs } = makeCapturingLogger();

   const docs: URI[] = [...knownDocuments];
   const langiumDocuments = {
      getOrCreateDocument: async (uri: URI) => {
         if (!docs.find(d => d.toString() === uri.toString())) {
            docs.push(uri);
         }
         return fakeDocument(uri);
      },
      hasDocument: (uri: URI) => docs.some(d => d.toString() === uri.toString()),
      getDocument: (uri: URI) => (docs.find(d => d.toString() === uri.toString()) ? fakeDocument(uri) : undefined),
      get all() {
         return docs.map(fakeDocument);
      }
   } as unknown as LangiumDocuments;

   const documentBuilder = {
      onUpdate: (listener: DocumentUpdateListener) => {
         updateListeners.push(listener);
         return Disposable.create(() => {
            const idx = updateListeners.indexOf(listener);
            if (idx >= 0) {
               updateListeners.splice(idx, 1);
            }
         });
      }
   } as unknown as DocumentBuilder;

   const fileSystemProvider = {
      readDirectory: async () => []
   } as unknown as FileSystemProvider;

   const workspaceManager = {
      wsRelativePath: (uri: URI | string): string => {
         const u = typeof uri === 'string' ? URI.parse(uri) : uri;
         return `${UriUtils.basename(UriUtils.dirname(u))}/${UriUtils.basename(u)}`;
      }
   };

   const triggerBuildUpdate = async (changed: URI[], deleted: URI[]): Promise<void> => {
      await Promise.all(updateListeners.map(listener => Promise.resolve(listener(changed, deleted))));
   };

   return {
      fileSystemProvider,
      langiumDocuments,
      documentBuilder,
      logger,
      workspaceManager,
      triggerBuildUpdate,
      logs,
      knownDocuments: docs
   };
}

/**
 * Concrete test subclass: descriptor identified by suffix; parsing pulls
 * from a controlled map; discovery skips the FS walk via override.
 */
class TestProjectManager extends AbstractProjectManager {
   readonly events: ProjectChangeEvent[] = [];
   descriptors = new Map<string, FakeDescriptor>();
   discoveryUris: URI[] = [];

   constructor(stubs: Stubs) {
      // The default Tracer wraps the Logger slot, so the manager's log lines
      // flow into stubs.logger (a capturing logger, asserted via stubs.logs).
      const services = makeNoopSharedServices({
         Logger: stubs.logger,
         workspace: {
            FileSystemProvider: stubs.fileSystemProvider,
            LangiumDocuments: stubs.langiumDocuments,
            DocumentBuilder: stubs.documentBuilder,
            WorkspaceManager: stubs.workspaceManager
         }
      });
      super(services);
      this.onProjectsChanged(event => this.events.push(event));
   }

   override isProjectDescriptor(uri: URI | string): boolean {
      return isDescriptorPredicate(uri);
   }

   protected override async parseProjectDescriptor(uri: URI): Promise<Project | undefined> {
      const descriptor = this.descriptors.get(uri.toString());
      if (!descriptor) {
         return undefined;
      }
      return {
         id: descriptor.id,
         referenceName: descriptor.referenceName ?? descriptor.id,
         version: descriptor.version,
         dependencies: descriptor.dependencies
      };
   }

   protected override async findDescriptorUris(): Promise<URI[]> {
      return this.discoveryUris;
   }
}

class TransitiveProjectManager extends TestProjectManager {
   protected override getAffectedProjects(directlyChanged: readonly string[]): readonly string[] {
      // Simple transitive: if a project depends on a changed one, include it.
      const result = new Set(directlyChanged);
      for (const p of this.getProjects()) {
         if (p.dependencies?.some(dep => result.has(dep))) {
            result.add(p.id);
         }
      }
      return [...result];
   }
}

// ============================================================
// Discovery
// ============================================================

describe('AbstractProjectManager — discovery', () => {
   it('parses descriptors, populates registry, resolves ready, emits added event', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];

      await mgr.discoverProjects([]);
      await mgr.ready;

      expect(
         mgr
            .getProjects()
            .map(p => p.id)
            .sort()
      ).toEqual(['A@1', 'B@1']);
      expect(mgr.getProjectById('A@1')?.id).toBe('A@1');
      expect(mgr.events).toHaveLength(1);
      expect([...mgr.events[0].added].sort()).toEqual(['A@1', 'B@1']);
      expect(mgr.events[0].updated).toEqual([]);
      expect(mgr.events[0].removed).toEqual([]);
   });

   it('discovery with no descriptors resolves ready and emits nothing', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      await mgr.discoverProjects([]);
      await mgr.ready;
      expect(mgr.getProjects()).toEqual([]);
      expect(mgr.events).toEqual([]);
   });

   it('discovery is fail-soft — invalid descriptors log and others continue', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      // B has no descriptor entry — parseProjectDescriptor returns undefined
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];

      await mgr.discoverProjects([]);
      expect(mgr.getProjects().map(p => p.id)).toEqual(['A@1']);
      expect(mgr.events[0].added).toEqual(['A@1']);
   });

   it('second discoverProjects call is ignored with a warning', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      expect(mgr.getProjects().map(p => p.id)).toEqual(['A@1']);
      expect(stubs.logs.some(l => l.level === 'warn' && l.message.includes('more than once'))).toBe(true);
   });
});

// ============================================================
// Queries
// ============================================================

describe('AbstractProjectManager — membership queries', () => {
   let stubs: Stubs;
   let mgr: TestProjectManager;

   beforeEach(async () => {
      stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_MEMBER_A1, URI_MEMBER_A2, URI_MEMBER_B1, URI_OUTSIDE]);
      mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
   });

   it('getProject returns the owning project for member URIs (closest-ancestor)', () => {
      expect(mgr.getProject(URI_MEMBER_A1)?.id).toBe('A@1');
      expect(mgr.getProject(URI_MEMBER_A2)?.id).toBe('A@1');
      expect(mgr.getProject(URI_MEMBER_B1)?.id).toBe('B@1');
   });

   it('getProject returns the project directly for descriptor URIs', () => {
      expect(mgr.getProject(URI_DESCRIPTOR_A)?.id).toBe('A@1');
   });

   it('getProject returns undefined for URIs outside any project', () => {
      expect(mgr.getProject(URI_OUTSIDE)).toBeUndefined();
   });

   it('getProject accepts string URIs', () => {
      expect(mgr.getProject(URI_MEMBER_A1.toString())?.id).toBe('A@1');
   });

   it('getProject delegates membership to the overridable computeProject seam', () => {
      class SeamManager extends TestProjectManager {
         protected override computeProject(): Project | undefined {
            return { id: 'SEAM', referenceName: 'seam', version: '1', dependencies: [] };
         }
      }
      const seamMgr = new SeamManager(stubs);
      // URI_OUTSIDE resolves to undefined via the default scan; overriding the seam wins.
      expect(seamMgr.getProject(URI_OUTSIDE)?.id).toBe('SEAM');
   });

   it('getProject does not return a stale project after a descriptor is removed (cache invalidation)', async () => {
      expect(mgr.getProject(URI_MEMBER_A1)?.id).toBe('A@1'); // prime the membership cache
      mgr.descriptors.delete(URI_DESCRIPTOR_A.toString());
      await stubs.triggerBuildUpdate([], [URI_DESCRIPTOR_A]);
      expect(mgr.getProject(URI_MEMBER_A1)).toBeUndefined();
   });

   it('getProjectUris lists member URIs for a project', () => {
      const uris = mgr.getProjectUris('A@1').map(u => u.toString());
      expect(uris).toContain(URI_DESCRIPTOR_A.toString());
      expect(uris).toContain(URI_MEMBER_A1.toString());
      expect(uris).toContain(URI_MEMBER_A2.toString());
      expect(uris).not.toContain(URI_MEMBER_B1.toString());
   });

   it('getProjectUris returns [] for unknown project id', () => {
      expect(mgr.getProjectUris('does-not-exist')).toEqual([]);
   });

   it('getVisibleProjects default walks Project.dependencies transitively', async () => {
      // Re-create with B → A so the transitive case is exercised.
      stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B]);
      const transitive = new TestProjectManager(stubs);
      transitive.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      transitive.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      transitive.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await transitive.discoverProjects([]);
      expect([...transitive.getVisibleProjects('B@1')].sort()).toEqual(['A@1', 'B@1']);
      // Self-only when there are no deps.
      expect(transitive.getVisibleProjects('A@1')).toEqual(['A@1']);
   });

   it('getVisibleProjects returns [] for unknown project id', () => {
      expect(mgr.getVisibleProjects('does-not-exist')).toEqual([]);
   });

   it('isVisible: cross-project visible via dependencies', async () => {
      stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B]);
      const transitive = new TestProjectManager(stubs);
      transitive.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      transitive.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      transitive.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await transitive.discoverProjects([]);
      expect(transitive.isVisible('B@1', 'A@1')).toBe(true);
   });

   it('isVisible: cross-project not visible without dependency', () => {
      expect(mgr.isVisible('A@1', 'B@1')).toBe(false);
   });

   it('isVisible: self gating via selfVisible flag', () => {
      expect(mgr.isVisible('A@1', 'A@1')).toBe(false); // default
      expect(mgr.isVisible('A@1', 'A@1', true)).toBe(true);
      expect(mgr.isVisible('A@1', 'A@1', false)).toBe(false);
   });

   it('isVisible: unknown source returns false regardless of selfVisible', () => {
      expect(mgr.isVisible('does-not-exist', 'A@1')).toBe(false);
      expect(mgr.isVisible('does-not-exist', 'does-not-exist', true)).toBe(false);
   });
});

// ============================================================
// Incremental updates
// ============================================================

describe('AbstractProjectManager — incremental updates', () => {
   it('ignores a virtual descriptor URI on build update (a virtual document is never a descriptor)', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      // A virtual document (no backing file) whose URI would otherwise match the
      // adopter's descriptor predicate (`.../project.a`). It must never be
      // treated as a project descriptor — indexing a contributed stdlib/library
      // virtual document must not spawn a phantom project.
      const virtualDescriptor = URI.parse('virtual:lib/project.a');
      mgr.descriptors.set(virtualDescriptor.toString(), { id: 'lib' });
      await stubs.triggerBuildUpdate([virtualDescriptor], []);

      expect(mgr.getProjects()).toEqual([]);
      expect(mgr.events).toEqual([]);
   });

   it('updates a project when its descriptor changes', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      // Same id, new version — counts as 'updated'
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', version: '2.0' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      expect(mgr.events).toHaveLength(1);
      expect(mgr.events[0].updated).toEqual(['A@1']);
      expect(mgr.events[0].added).toEqual([]);
      expect(mgr.events[0].removed).toEqual([]);
      expect(mgr.getProjectById('A@1')?.version).toBe('2.0');
   });

   it('adds a new project when a new descriptor appears', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      stubs.knownDocuments.push(URI_DESCRIPTOR_B);
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_B], []);

      expect(mgr.events[0].added).toEqual(['B@1']);
      expect(mgr.events[0].updated).toEqual([]);
      expect(
         mgr
            .getProjects()
            .map(p => p.id)
            .sort()
      ).toEqual(['A@1', 'B@1']);
   });

   it('removes a project when its descriptor is deleted', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', version: '3.0' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      await stubs.triggerBuildUpdate([], [URI_DESCRIPTOR_B]);
      expect(mgr.events[0].removed.map(entry => entry.id)).toEqual(['B@1']);
      expect(mgr.events[0].removed).toHaveLength(1);
      expect(mgr.events[0].removed[0].snapshot.id).toBe('B@1');
      expect(mgr.events[0].removed[0].snapshot.version).toBe('3.0');
      expect(mgr.getProjects().map(p => p.id)).toEqual(['A@1']);
   });

   it('treats a descriptor id change as remove-old + add-new', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@2' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      expect(mgr.events[0].added).toEqual(['A@2']);
      expect(mgr.events[0].removed.map(entry => entry.id)).toEqual(['A@1']);
      expect(mgr.events[0].updated).toEqual([]);
   });

   it('ignores non-descriptor URIs in the update', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      await stubs.triggerBuildUpdate([URI_MEMBER_A1], []);
      expect(mgr.events).toEqual([]);
   });

   it('emits nothing when a changed descriptor produces no registry change', async () => {
      // A descriptor-shaped URI that never parsed (no descriptor entry) and was
      // never registered. It survives the descriptor filter, so onBuildUpdate's
      // no-descriptors early return does NOT fire, but the per-URI loop adds
      // nothing: newProject is undefined and previousProjectId is undefined, so
      // added/updated/removed all stay empty. The all-three-empty guard before
      // the emit must suppress it; an `if (false)` mutant of that guard instead
      // emits an empty `{ added: [], updated: [], removed: [] }` event.
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      // Note: no descriptors registered, no discovery — registry is empty.
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);
      expect(mgr.events).toEqual([]);
   });

   it('affectedDocuments excludes descriptor URIs and includes member URIs of changed projects', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_MEMBER_A1, URI_MEMBER_A2, URI_MEMBER_B1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', referenceName: 'A-renamed' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      const affected = mgr.events[0].affectedDocuments.map(u => u.toString());
      expect(affected).toContain(URI_MEMBER_A1.toString());
      expect(affected).toContain(URI_MEMBER_A2.toString());
      expect(affected).not.toContain(URI_MEMBER_B1.toString());
      expect(affected).not.toContain(URI_DESCRIPTOR_A.toString());
   });

   it('a metadata-only change (version) emits updated but rebuilds no members', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1, URI_MEMBER_A2]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      // version is pass-through metadata the framework never reads, so
      // requiresMemberRebuild returns false: the event still reports the
      // project as updated, but no member documents are scheduled to rebuild.
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', version: '2.0' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      expect(mgr.events).toHaveLength(1);
      expect(mgr.events[0].updated).toEqual(['A@1']);
      expect(mgr.events[0].affectedDocuments).toEqual([]);
      expect(mgr.getProjectById('A@1')?.version).toBe('2.0');
   });

   it('a dependencies change rebuilds the project members', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      // Gaining a dependency changes the visibility closure — a member-observable
      // build input — so members must rebuild.
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', dependencies: ['B@1'] });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      expect(mgr.events[0].updated).toEqual(['A@1']);
      expect(mgr.events[0].affectedDocuments.map(u => u.toString())).toContain(URI_MEMBER_A1.toString());
   });

   it('getAffectedProjects override drives transitive cascade through affectedDocuments', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_MEMBER_A1, URI_MEMBER_B1]);
      const mgr = new TransitiveProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', referenceName: 'A-renamed' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      const affected = mgr.events[0].affectedDocuments.map(u => u.toString());
      // A's own member + B's member (transitive)
      expect(affected).toContain(URI_MEMBER_A1.toString());
      expect(affected).toContain(URI_MEMBER_B1.toString());
   });
});

// ============================================================
// Listener registration / disposal
// ============================================================

describe('AbstractProjectManager — onProjectsChanged', () => {
   it('listener fires on registry change and dispose stops it', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];

      const received: ProjectChangeEvent[] = [];
      const disposable = mgr.onProjectsChanged(e => received.push(e));
      await mgr.discoverProjects([]);
      expect(received).toHaveLength(1);

      disposable.dispose();
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', referenceName: 'A-renamed' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);
      expect(received).toHaveLength(1); // unchanged after dispose
   });

   it('a throwing listener does not prevent other listeners from running', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];

      mgr.onProjectsChanged(() => {
         throw new Error('boom');
      });
      const received: ProjectChangeEvent[] = [];
      mgr.onProjectsChanged(e => received.push(e));

      await mgr.discoverProjects([]);
      expect(received).toHaveLength(1);
      expect(stubs.logs.some(l => l.level === 'error' && l.message.includes('boom'))).toBe(true);
   });
});

// ============================================================
// isUnqualifiedProjectReference / isSingleProject
// ============================================================

describe('AbstractProjectManager — isUnqualifiedProjectReference', () => {
   it('true when the owning project uses the unqualified-reference sentinel', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      // parseProjectDescriptor sets referenceName = id; use the sentinel as the id
      // so the owning project's referenceName === UNQUALIFIED_PROJECT_REFERENCE.
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: UNQUALIFIED_PROJECT_REFERENCE });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      expect(mgr.isUnqualifiedProjectReference(URI_MEMBER_A1)).toBe(true);
   });

   it('false when the owning project has a qualified reference name', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      // referenceName === 'A@1' !== '' → must be false. Kills the
      // ConditionalExpression `true`/`||false`→true and EqualityOperator (!==) mutants.
      expect(mgr.isUnqualifiedProjectReference(URI_MEMBER_A1)).toBe(false);
   });

   it('true when the URI is owned by no project at all', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_OUTSIDE]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      // getProject(URI_OUTSIDE) === undefined → first disjunct true. Kills the
      // `project === undefined` → `false` and the LogicalOperator (&&) mutants.
      expect(mgr.isUnqualifiedProjectReference(URI_OUTSIDE)).toBe(true);
   });
});

describe('AbstractProjectManager — isSingleProject', () => {
   it('true with zero projects', () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      expect(mgr.isSingleProject()).toBe(true);
   });

   it('true with exactly one project', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      // length 1 → <= 1 → true. Kills `< 1` (would be false) and the `false` literal mutant.
      expect(mgr.isSingleProject()).toBe(true);
   });

   it('false with two projects', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      // length 2 → false. Kills `> 1` (true), `true` literal, and `< 1` mutants.
      expect(mgr.isSingleProject()).toBe(false);
   });
});

// ============================================================
// Default filesystem descriptor walk (findDescriptorUris /
// walkForDescriptors / shouldEnterDirectory) — not overridden here.
// ============================================================

interface FsTree {
   [path: string]: Array<{ name: string; dir?: boolean }>;
}

/**
 * Test manager that uses the *default* FS-walking discovery (no
 * findDescriptorUris override) backed by an in-memory directory tree.
 */
class WalkingProjectManager extends AbstractProjectManager {
   readonly events: ProjectChangeEvent[] = [];

   constructor(stubs: Stubs) {
      // The default Tracer wraps the Logger slot, so the manager's log lines
      // flow into stubs.logger (a capturing logger, asserted via stubs.logs).
      const services = makeNoopSharedServices({
         Logger: stubs.logger,
         workspace: {
            FileSystemProvider: stubs.fileSystemProvider,
            LangiumDocuments: stubs.langiumDocuments,
            DocumentBuilder: stubs.documentBuilder,
            WorkspaceManager: stubs.workspaceManager
         }
      });
      super(services);
      this.onProjectsChanged(event => this.events.push(event));
   }

   override isProjectDescriptor(uri: URI | string): boolean {
      return isDescriptorPredicate(uri);
   }

   protected override async parseProjectDescriptor(uri: URI): Promise<Project | undefined> {
      return { id: uri.toString(), referenceName: uri.toString() };
   }
}

function makeFsStubs(tree: FsTree): Stubs {
   const stubs = makeStubs();
   const fileSystemProvider = {
      readDirectory: async (dir: URI) => {
         const entries = tree[dir.toString()] ?? [];
         return entries.map(entry => ({
            uri: URI.parse(dir.toString() + '/' + entry.name),
            isDirectory: !!entry.dir,
            isFile: !entry.dir
         }));
      }
   } as unknown as FileSystemProvider;
   return { ...stubs, fileSystemProvider };
}

describe('AbstractProjectManager — default FS descriptor walk', () => {
   const ROOT = 'file:///ws';

   it('walks recursively and collects descriptor files', async () => {
      const tree: FsTree = {
         [ROOT]: [{ name: 'project.a' }, { name: 'sub', dir: true }, { name: 'README.md' }],
         [ROOT + '/sub']: [{ name: 'project.a' }, { name: 'Element.a' }]
      };
      const stubs = makeFsStubs(tree);
      const mgr = new WalkingProjectManager(stubs);
      await mgr.discoverProjects([{ uri: ROOT, name: 'ws' }]);
      const ids = mgr
         .getProjects()
         .map(p => p.id)
         .sort();
      // Both project.a descriptors found; the non-descriptor files excluded.
      // Kills the walk's `isFile && isDescriptorUri` → `||` LogicalOperator and
      // the `isFile`→true/false ConditionalExpression mutants, plus its
      // isDirectory branch.
      expect(ids).toEqual([ROOT + '/project.a', ROOT + '/sub/project.a']);
   });

   it('skips hidden, node_modules and out directories', async () => {
      const tree: FsTree = {
         [ROOT]: [
            { name: '.hidden', dir: true },
            { name: 'node_modules', dir: true },
            { name: 'out', dir: true },
            { name: 'src', dir: true }
         ],
         [ROOT + '/.hidden']: [{ name: 'project.a' }],
         [ROOT + '/node_modules']: [{ name: 'project.a' }],
         [ROOT + '/out']: [{ name: 'project.a' }],
         [ROOT + '/src']: [{ name: 'project.a' }]
      };
      const stubs = makeFsStubs(tree);
      const mgr = new WalkingProjectManager(stubs);
      await mgr.discoverProjects([{ uri: ROOT, name: 'ws' }]);
      const ids = mgr.getProjects().map(p => p.id);
      // Only src/project.a survives the shouldEnterDirectory filter.
      // Kills shouldEnterDirectory's startsWith('.'), node_modules and out
      // EqualityOperator / LogicalOperator / BooleanLiteral mutants and the
      // `return false`→`return true` flip on hidden dirs.
      expect(ids).toEqual([ROOT + '/src/project.a']);
   });

   it('enters a normal directory whose name merely contains a dot', async () => {
      // 'a.b' does not start with '.', is not node_modules/out → must be entered.
      // Distinguishes startsWith('.') from endsWith('.') / includes mutants.
      const tree: FsTree = {
         [ROOT]: [{ name: 'a.b', dir: true }],
         [ROOT + '/a.b']: [{ name: 'project.a' }]
      };
      const stubs = makeFsStubs(tree);
      const mgr = new WalkingProjectManager(stubs);
      await mgr.discoverProjects([{ uri: ROOT, name: 'ws' }]);
      expect(mgr.getProjects().map(p => p.id)).toEqual([ROOT + '/a.b/project.a']);
   });

   it('a directory ending in a dot is still entered (kills endsWith mutant)', async () => {
      // shouldEnterDirectory uses startsWith('.'); a name ending in '.' must NOT
      // be skipped. Under the MethodExpression mutant (endsWith) it would be skipped.
      const tree: FsTree = {
         [ROOT]: [{ name: 'trailing.', dir: true }],
         [ROOT + '/trailing.']: [{ name: 'project.a' }]
      };
      const stubs = makeFsStubs(tree);
      const mgr = new WalkingProjectManager(stubs);
      await mgr.discoverProjects([{ uri: ROOT, name: 'ws' }]);
      expect(mgr.getProjects().map(p => p.id)).toEqual([ROOT + '/trailing./project.a']);
   });

   it('logs a warning and continues when a directory cannot be read', async () => {
      const stubs = makeStubs();
      const failing = {
         readDirectory: async () => {
            throw new Error('EACCES');
         }
      } as unknown as FileSystemProvider;
      const mgr = new WalkingProjectManager({ ...stubs, fileSystemProvider: failing });
      await mgr.discoverProjects([{ uri: ROOT, name: 'ws' }]);
      expect(mgr.getProjects()).toEqual([]);
      // Kills the warn StringLiteral→'' mutant (message must mention the failure).
      expect(stubs.logs.some(l => l.level === 'warn' && l.message.includes('Failed to read directory'))).toBe(true);
   });

   it('collects descriptors from multiple workspace folders', async () => {
      const ROOT2 = 'file:///ws2';
      const tree: FsTree = {
         [ROOT]: [{ name: 'project.a' }],
         [ROOT2]: [{ name: 'project.a' }]
      };
      const stubs = makeFsStubs(tree);
      const mgr = new WalkingProjectManager(stubs);
      await mgr.discoverProjects([
         { uri: ROOT, name: 'ws' },
         { uri: ROOT2, name: 'ws2' }
      ]);
      // Kills the `for (const folder of folders)` empty-body mutant: with an
      // empty loop only one (or zero) folder would be walked.
      expect(
         mgr
            .getProjects()
            .map(p => p.id)
            .sort()
      ).toEqual([ROOT + '/project.a', ROOT2 + '/project.a']);
   });
});

// ============================================================
// getProject closest-ancestor selection
// ============================================================

describe('AbstractProjectManager — getProject closest-ancestor', () => {
   const OUTER_DESC = URI.parse('file:///ws/project.a');
   const INNER_DESC = URI.parse('file:///ws/inner/project.a');
   const INNER_MEMBER = URI.parse('file:///ws/inner/Element.a');
   const OUTER_MEMBER = URI.parse('file:///ws/Element.a');

   async function nested(): Promise<TestProjectManager> {
      const stubs = makeStubs([OUTER_DESC, INNER_DESC, INNER_MEMBER, OUTER_MEMBER]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(OUTER_DESC.toString(), { id: 'OUTER' });
      mgr.descriptors.set(INNER_DESC.toString(), { id: 'INNER' });
      mgr.discoveryUris = [OUTER_DESC, INNER_DESC];
      await mgr.discoverProjects([]);
      return mgr;
   }

   it('picks the deepest ancestor descriptor directory (longest fsPath wins)', async () => {
      const mgr = await nested();
      // INNER_MEMBER is under both ws/ and ws/inner/; the longer path must win.
      // Kills computeProject's `directory.fsPath.length > bestLength` → `&& true`
      // (would pick the first match) and `>=` EqualityOperator mutants, plus the
      // `bestLength = -1` seed's UnaryOperator mutant.
      expect(mgr.getProject(INNER_MEMBER)?.id).toBe('INNER');
   });

   it('deepest ancestor wins regardless of descriptor registration / iteration order', async () => {
      // The descriptorDirectories Map iterates in insertion order. Register the
      // OUTER descriptor LAST so it is the final match the `&& true` mutant
      // sees. With `length > bestLength` replaced by `&& true`, the loop keeps
      // overwriting `bestDescriptorUri` with whichever ancestor it visits last
      // (= OUTER here) — so it would wrongly return OUTER. The unmutated code
      // still returns INNER because /ws/inner is the strictly-longer ancestor.
      const stubs = makeStubs([OUTER_DESC, INNER_DESC, INNER_MEMBER]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(INNER_DESC.toString(), { id: 'INNER' });
      mgr.descriptors.set(OUTER_DESC.toString(), { id: 'OUTER' });
      // INNER inserted first, OUTER inserted last → OUTER is the last Map entry.
      mgr.discoveryUris = [INNER_DESC, OUTER_DESC];
      await mgr.discoverProjects([]);
      expect(mgr.getProject(INNER_MEMBER)?.id).toBe('INNER');
   });

   it('a member only under the outer project resolves to the outer project', async () => {
      const mgr = await nested();
      expect(mgr.getProject(OUTER_MEMBER)?.id).toBe('OUTER');
   });

   it('a direct descriptor hit short-circuits ancestor search', async () => {
      const mgr = await nested();
      // INNER_DESC is itself a descriptor → direct hit returns INNER even though
      // OUTER is also an ancestor. Kills the `if (false)` mutant of
      // computeProject's direct-descriptor-hit branch.
      expect(mgr.getProject(INNER_DESC)?.id).toBe('INNER');
   });

   it('returns undefined when no descriptor directory is an ancestor', async () => {
      const mgr = await nested();
      // Kills the `!bestDescriptorUri` → `if (false)` mutant in computeProject
      // (would then try to index projectByDescriptor with undefined).
      expect(mgr.getProject(URI.parse('file:///elsewhere/Thing.a'))).toBeUndefined();
   });
});

// ============================================================
// getAffectedProjects default transitive cascade (reverse dep walk)
// ============================================================

describe('AbstractProjectManager — default getAffectedProjects cascade', () => {
   it('walks the dependency graph transitively in reverse', async () => {
      // C → B → A. A change to A must cascade to B and C through the default
      // getAffectedProjects fixpoint loop (no override).
      const URI_C_DESC = URI.parse('file:///workspace/projC/project.a');
      const URI_C_MEMBER = URI.parse('file:///workspace/projC/Element.a');
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_C_DESC, URI_MEMBER_A1, URI_MEMBER_B1, URI_C_MEMBER]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      mgr.descriptors.set(URI_C_DESC.toString(), { id: 'C@1', dependencies: ['B@1'] });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_C_DESC];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', referenceName: 'A-renamed' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      const affected = mgr.events[0].affectedDocuments.map(u => u.toString());
      // The transitive (two-hop) reach to C only happens if the `while (grew)`
      // loop iterates more than once. Kills the `grew = true`→false BooleanLiteral,
      // `while (false)` ConditionalExpression, and the `some`→`every` mutants.
      expect(affected).toContain(URI_MEMBER_A1.toString());
      expect(affected).toContain(URI_MEMBER_B1.toString());
      expect(affected).toContain(URI_C_MEMBER.toString());
   });

   it('does not cascade to an unrelated project', async () => {
      // B depends on A; X depends on nothing. A change to A must NOT affect X.
      // In getAffectedProjects, kills the `result.has(project.id)` → `if (true)`
      // mutant (would skip-continue every project, breaking the cascade) and the
      // `dependencies?.some(...)` → `if (true)` mutant (would pull in X).
      const URI_X_DESC = URI.parse('file:///workspace/projX/project.a');
      const URI_X_MEMBER = URI.parse('file:///workspace/projX/Element.a');
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_X_DESC, URI_MEMBER_B1, URI_X_MEMBER]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      mgr.descriptors.set(URI_X_DESC.toString(), { id: 'X@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B, URI_X_DESC];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', referenceName: 'A-renamed' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      const affected = mgr.events[0].affectedDocuments.map(u => u.toString());
      expect(affected).toContain(URI_MEMBER_B1.toString());
      expect(affected).not.toContain(URI_X_MEMBER.toString());
   });
});

// ============================================================
// getVisibleProjects cycle-safety (collectVisibleProjects visited guard)
// ============================================================

describe('AbstractProjectManager — getVisibleProjects cycles', () => {
   it('handles a dependency cycle without infinite recursion or duplicates', async () => {
      // A → B → A. collectVisibleProjects' visited guard must stop the recursion.
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_DESCRIPTOR_B]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', dependencies: ['B@1'] });
      mgr.descriptors.set(URI_DESCRIPTOR_B.toString(), { id: 'B@1', dependencies: ['A@1'] });
      mgr.discoveryUris = [URI_DESCRIPTOR_A, URI_DESCRIPTOR_B];
      await mgr.discoverProjects([]);
      // Each project appears exactly once. Kills the `visited.has` → `if (false)`
      // mutant (would recurse forever / duplicate entries).
      expect([...mgr.getVisibleProjects('A@1')].sort()).toEqual(['A@1', 'B@1']);
   });

   it('skips a declared dependency that is not registered', async () => {
      // A declares a dep on a project that does not exist. collectVisibleProjects
      // must add the missing id to `visited` but not to `ordered`.
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', dependencies: ['GHOST'] });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      // GHOST is visited but yields no project → not in the result. Kills the
      // unregistered-id `!project` → `if (false)` mutant (would push GHOST).
      expect([...mgr.getVisibleProjects('A@1')]).toEqual(['A@1']);
   });
});

// ============================================================
// emit listener-snapshot isolation (the .slice() in emit)
// ============================================================

describe('AbstractProjectManager — emit snapshot isolation', () => {
   it('a listener that registers another listener during emit does not fire it for the same event', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];

      const lateCalls: ProjectChangeEvent[] = [];
      mgr.onProjectsChanged(() => {
         // Register a second listener mid-iteration. The emit() snapshot (.slice())
         // means it must NOT receive the current event. Without the slice the
         // mutated live array would feed it the same event.
         mgr.onProjectsChanged(event => lateCalls.push(event));
      });

      await mgr.discoverProjects([]);
      // Kills emit's `.slice()` → identity MethodExpression mutant.
      expect(lateCalls).toHaveLength(0);
   });
});

// ============================================================
// onBuildUpdate: invalid descriptor drops a previously-valid project
// ============================================================

describe('AbstractProjectManager — descriptor becomes invalid', () => {
   it('drops a project whose descriptor no longer parses', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A, URI_MEMBER_A1]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      mgr.events.length = 0;

      // Remove the descriptor entry so parseProjectDescriptor returns undefined.
      mgr.descriptors.delete(URI_DESCRIPTOR_A.toString());
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);

      // Exercises onBuildUpdate's `else if (previousProjectId)` invalid-descriptor
      // branch and its `if (previousProject)` snapshot push. Kills the `if (false)`
      // mutants of both.
      expect(mgr.events[0].removed.map(entry => entry.id)).toEqual(['A@1']);
      expect(mgr.getProjects()).toEqual([]);
   });
});

// ============================================================
// Project change logging
// ============================================================

/** Subclass that renames the user-facing concept to an adopter's own term. */
class CustomConceptManager extends TestProjectManager {
   protected override conceptName(): string {
      return 'model set';
   }
}

describe('AbstractProjectManager — change logging', () => {
   it('logs Add/Update with the default concept name and ws-relative location on discovery', async () => {
      const stubs = makeStubs();
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      expect(stubs.logs).toContainEqual({ level: 'info', message: 'Add/Update project "A@1" from projA/project.a' });
   });

   it('logs Add/Update on an incremental descriptor update', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      stubs.logs.length = 0;

      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1', version: '2.0' });
      await stubs.triggerBuildUpdate([URI_DESCRIPTOR_A], []);
      expect(stubs.logs).toContainEqual({ level: 'info', message: 'Add/Update project "A@1" from projA/project.a' });
   });

   it('logs Remove with the concept name and location when a descriptor is deleted', async () => {
      const stubs = makeStubs([URI_DESCRIPTOR_A]);
      const mgr = new TestProjectManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      stubs.logs.length = 0;

      await stubs.triggerBuildUpdate([], [URI_DESCRIPTOR_A]);
      expect(stubs.logs).toContainEqual({ level: 'info', message: 'Remove project "A@1" from projA/project.a' });
   });

   it('uses the overridden concept name in change-log lines', async () => {
      const stubs = makeStubs();
      const mgr = new CustomConceptManager(stubs);
      mgr.descriptors.set(URI_DESCRIPTOR_A.toString(), { id: 'A@1' });
      mgr.discoveryUris = [URI_DESCRIPTOR_A];
      await mgr.discoverProjects([]);
      expect(stubs.logs).toContainEqual({ level: 'info', message: 'Add/Update model set "A@1" from projA/project.a' });
   });
});
