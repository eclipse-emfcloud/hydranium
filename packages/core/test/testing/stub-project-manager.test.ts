/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubProjectManager` measured against the `AbstractProjectManager` it
 * doubles, rather than against itself.
 *
 * Type conformance is not what needs a test here: `StubProjectManager` is
 * declared `extends ProjectManager<TProject>` in shipped source, so a member
 * added to or changed on the interface already fails `npm run build`. What no
 * compiler can see is the stub's *behavioural* claim — that
 * `getProjectUris` / `getVisibleProjects` / `isVisible` compute what
 * `AbstractProjectManager` computes. A suite that exercised the stub alone
 * would pass under any answer the stub chose to give, and would then certify a
 * visibility model no production manager implements. So both are seeded with
 * one project graph and their answers compared id-by-id and pair-by-pair.
 *
 * The comparison alone is satisfied by two managers that both answer nothing,
 * which is what an unseeded real manager does. Hence the explicit anchors on
 * the real side: they fail if the graph never reached the registry, so a green
 * differential means the two agreed on real answers.
 */

import { describe, expect, it } from 'vitest';
import { type Project, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import { URI, UriUtils } from '@hydranium/langium';
import { AbstractProjectManager } from '../../src/langium/project/abstract-project-manager.js';
import {
   makeNoopSharedServices,
   makeStubDocumentBuilder,
   makeStubLangiumDocuments,
   makeStubProjectManager
} from '../../src/testing/index.js';

/**
 * A chain, a diamond re-reaching an already-visited node, a two-node cycle and
 * a dependency on an id no project carries — the four shapes the closure walk
 * has to terminate on.
 */
const GRAPH: readonly Project[] = [
   { id: 'p-leaf', referenceName: 'leaf' },
   { id: 'p-mid', referenceName: 'mid', dependencies: ['p-leaf'] },
   { id: 'p-root', referenceName: 'root', dependencies: ['p-mid'] },
   { id: 'p-diamond', referenceName: 'diamond', dependencies: ['p-mid', 'p-leaf'] },
   { id: 'p-cycle-a', referenceName: 'cycle-a', dependencies: ['p-cycle-b'] },
   { id: 'p-cycle-b', referenceName: 'cycle-b', dependencies: ['p-cycle-a'] },
   { id: 'p-dangling', referenceName: UNQUALIFIED_PROJECT_REFERENCE, dependencies: ['p-absent'] }
];

/** Every registered id plus one that is registered nowhere. */
const IDS: readonly string[] = [...GRAPH.map(project => project.id), 'p-absent'];

function descriptorUri(projectId: string): URI {
   return URI.parse(`file:///ws/${projectId}/project.x`);
}

/**
 * Minimal concrete `AbstractProjectManager`: descriptors come from a map
 * instead of the filesystem walk, so no real workspace is involved and the
 * registry contents are exactly `GRAPH`.
 */
class DifferentialProjectManager extends AbstractProjectManager {
   private readonly byDescriptor = new Map<string, Project>();

   constructor(graph: readonly Project[]) {
      super(
         makeNoopSharedServices({
            workspace: {
               LangiumDocuments: makeStubLangiumDocuments(),
               DocumentBuilder: makeStubDocumentBuilder(),
               WorkspaceManager: { wsRelativePath: (uri: URI | string) => UriUtils.toUri(uri).path }
            }
         })
      );
      for (const project of graph) {
         this.byDescriptor.set(descriptorUri(project.id).toString(), project);
      }
   }

   override isProjectDescriptor(uri: URI | string): boolean {
      return UriUtils.toUri(uri).path.endsWith('/project.x');
   }

   protected override async parseProjectDescriptor(uri: URI): Promise<Project | undefined> {
      return this.byDescriptor.get(uri.toString());
   }

   protected override async findDescriptorUris(): Promise<URI[]> {
      return [...this.byDescriptor.keys()].map(descriptor => URI.parse(descriptor));
   }
}

async function realManager(): Promise<DifferentialProjectManager> {
   const manager = new DifferentialProjectManager(GRAPH);
   await manager.discoverProjects([]);
   await manager.ready;
   return manager;
}

describe('makeStubProjectManager — differential against AbstractProjectManager', () => {
   it('holds the same registry, in the same order, on both sides', async () => {
      const real = await realManager();
      const stub = makeStubProjectManager(GRAPH);

      const ids = GRAPH.map(project => project.id);
      expect(real.getProjects().map(project => project.id)).toEqual(ids);
      expect(stub.getProjects().map(project => project.id)).toEqual(ids);
      expect(real.getProjectById('p-mid')?.referenceName).toBe(stub.getProjectById('p-mid')?.referenceName);
      expect(real.getProjectById('p-absent')).toBeUndefined();
      expect(stub.getProjectById('p-absent')).toBeUndefined();
   });

   it('answers getVisibleProjects identically for every id, closure order included', async () => {
      const real = await realManager();
      const stub = makeStubProjectManager(GRAPH);

      const realAnswers = IDS.map(id => real.getVisibleProjects(id));
      expect(IDS.map(id => stub.getVisibleProjects(id))).toEqual(realAnswers);

      // Two managers that both answer `[]` everywhere satisfy the comparison
      // above, so pin the answers that carry the closure — these fail if the
      // graph never reached the real registry.
      expect(realAnswers[IDS.indexOf('p-root')]).toEqual(['p-root', 'p-mid', 'p-leaf']);
      expect(realAnswers[IDS.indexOf('p-diamond')]).toEqual(['p-diamond', 'p-mid', 'p-leaf']);
      expect(realAnswers[IDS.indexOf('p-cycle-a')]).toEqual(['p-cycle-a', 'p-cycle-b']);
      expect(realAnswers[IDS.indexOf('p-dangling')]).toEqual(['p-dangling']);
      expect(realAnswers[IDS.indexOf('p-absent')]).toEqual([]);
   });

   it('answers isVisible identically for every ordered pair under both selfVisible settings', async () => {
      const real = await realManager();
      const stub = makeStubProjectManager(GRAPH);

      const cases = IDS.flatMap(source => IDS.flatMap(target => [true, false].map(selfVisible => ({ source, target, selfVisible }))));
      const realAnswers = cases.map(probe => real.isVisible(probe.source, probe.target, probe.selfVisible));
      expect(cases.map(probe => stub.isVisible(probe.source, probe.target, probe.selfVisible))).toEqual(realAnswers);

      // Same anchoring argument: an all-`false` pair of managers would agree.
      expect(realAnswers.filter(answer => answer).length).toBeGreaterThan(0);
      expect(real.isVisible('p-root', 'p-leaf')).toBe(true);
      expect(real.isVisible('p-leaf', 'p-root')).toBe(false);
      expect(real.isVisible('p-root', 'p-root')).toBe(false);
      expect(real.isVisible('p-root', 'p-root', true)).toBe(true);
   });

   it('answers no member URIs for an unregistered project id, like the real manager', async () => {
      const real = await realManager();
      const stub = makeStubProjectManager(GRAPH);
      stub.ownUri('file:///ws/p-leaf/One.x', 'p-leaf');
      stub.ownUri('file:///ws/elsewhere/Two.x', 'p-absent');

      expect(stub.getProjectUris('p-leaf').map(uri => uri.toString())).toEqual([URI.parse('file:///ws/p-leaf/One.x').toString()]);
      // The real manager gates on registration before it walks documents, so an
      // id no project carries answers empty however the workspace is laid out.
      // A stub that answered from ownership alone would let a test assert
      // membership for a project that was never registered.
      expect(real.getProjectUris('p-absent')).toEqual([]);
      expect(stub.getProjectUris('p-absent')).toEqual([]);
   });

   it('reports isSingleProject and isUnqualifiedProjectReference the way the real manager does', async () => {
      const real = await realManager();
      const stub = makeStubProjectManager(GRAPH);
      const single = makeStubProjectManager([GRAPH[0]]);
      const empty = makeStubProjectManager();

      expect(real.isSingleProject()).toBe(false);
      expect(stub.isSingleProject()).toBe(false);
      expect(single.isSingleProject()).toBe(true);
      expect(empty.isSingleProject()).toBe(true);

      // Both managers read `referenceName` off the OWNING project and treat an
      // unowned URI as unqualified, so the stub's ownership map is what decides.
      stub.ownUri('file:///ws/p-dangling/One.x', 'p-dangling');
      stub.ownUri('file:///ws/p-leaf/One.x', 'p-leaf');
      expect(stub.isUnqualifiedProjectReference('file:///ws/p-dangling/One.x')).toBe(true);
      expect(stub.isUnqualifiedProjectReference('file:///ws/p-leaf/One.x')).toBe(false);
      expect(stub.isUnqualifiedProjectReference('file:///ws/nobody/One.x')).toBe(true);
      expect(real.isUnqualifiedProjectReference('file:///ws/nobody-at-all/One.x')).toBe(true);
   });
});

describe('makeStubProjectManager — the seams a test drives it through', () => {
   it('delivers a fired change event to live listeners and stops at dispose', () => {
      const stub = makeStubProjectManager(GRAPH);
      const seen: string[][] = [];
      const subscription = stub.onProjectsChanged(event => seen.push([...event.added]));
      stub.onProjectsChanged(() => undefined);

      stub.fireProjectsChanged({ added: ['p-leaf'], updated: [], removed: [], affectedDocuments: [] });
      subscription.dispose();
      stub.fireProjectsChanged({ added: ['p-mid'], updated: [], removed: [], affectedDocuments: [] });

      // The first arrival is asserted too: a listener wired to nothing also
      // produces an empty log after dispose.
      expect(seen).toEqual([['p-leaf']]);
   });

   it('answers getProject from the ownership map and abstains for an unowned URI', () => {
      const stub = makeStubProjectManager(GRAPH);
      stub.ownUri('file:///ws/p-mid/One.x', 'p-mid');

      // The positive lookup, kept from the block this file superseded in
      // `make-test-services.test.ts`: every other assertion here reads the
      // ownership map through a derived answer, so nothing else fails if
      // `getProject` stopped resolving the owning project itself.
      expect(stub.getProject('file:///ws/p-mid/One.x')?.id).toBe('p-mid');
      expect(stub.getProject('file:///ws/p-mid/One.x')?.dependencies).toEqual(['p-leaf']);
      expect(stub.getProject('file:///ws/nobody/One.x')).toBeUndefined();
   });

   it('exposes projects as the live backing array, so a splice is visible to queries', () => {
      const stub = makeStubProjectManager(GRAPH);
      stub.projects.splice(0, stub.projects.length, { id: 'p-only', referenceName: 'only' });

      expect(stub.getProjects().map(project => project.id)).toEqual(['p-only']);
      expect(stub.isSingleProject()).toBe(true);
      expect(stub.getVisibleProjects('p-leaf')).toEqual([]);
   });

   it('drops projects, ownership and listeners on reset', () => {
      const stub = makeStubProjectManager(GRAPH);
      const seen: number[] = [];
      stub.onProjectsChanged(() => seen.push(1));
      stub.ownUri(URI.parse('file:///ws/p-leaf/One.x'), 'p-leaf');

      stub.reset();
      stub.fireProjectsChanged({ added: [], updated: [], removed: [], affectedDocuments: [] });

      expect(stub.getProjects()).toEqual([]);
      expect(stub.getProject('file:///ws/p-leaf/One.x')).toBeUndefined();
      expect(seen).toEqual([]);
   });
});
