/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, bench, describe, expect } from 'vitest';
import { type Project, Disposable } from '@hydranium/protocol';
import { type AstNodeDescription, MapScope, type Stream, URI } from '@hydranium/langium';
import { AbstractProjectManager } from '../../../src/langium/project/abstract-project-manager.js';
import { DefaultHydraniumScopeProvider } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { makeFakeDescription, makeNoopLanguageServices, makeNoopSharedServices } from '../../../src/testing/index.js';

/** Seed the registry without descriptor I/O. Queries use the production implementations. */
class ProjectProbe extends AbstractProjectManager {
   enumerated = 0;
   dependencyReads = 0;

   constructor(size: number, chain = false) {
      super(makeNoopSharedServices({ workspace: { DocumentBuilder: { onUpdate: () => Disposable.EMPTY } } }));
      for (let i = 0; i < size; i++) {
         const id = `p${i}`;
         const dependencies = chain && i + 1 < size ? [`p${i + 1}`] : [];
         const project: Project = { id, referenceName: id };
         Object.defineProperty(project, 'dependencies', {
            get: () => {
               this.dependencyReads++;
               return dependencies;
            }
         });
         this.projects.set(id, project);
         const uri = URI.parse(`file:///${id}/project.x`);
         this.projectByDescriptor.set(uri.toString(), id);
         this.descriptorDirectories.set(uri.toString(), URI.parse(`file:///${id}`));
      }
      const values = this.projects.values.bind(this.projects);
      this.projects.values = () => {
         this.enumerated += this.projects.size;
         return values();
      };
   }

   affected(id: string): readonly string[] {
      return this.getAffectedProjects([id]);
   }

   override isProjectDescriptor(uri: URI | string): boolean {
      return uri.toString().endsWith('/project.x');
   }

   protected override async parseProjectDescriptor(): Promise<undefined> {
      return undefined;
   }
}

class ScopeProbe extends MapScope {
   inspected = 0;
   override getAllElements(): Stream<AstNodeDescription> {
      return super.getAllElements().map(description => {
         this.inspected++;
         return description;
      });
   }
}

const observations: object[] = [];
const options = { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 };

describe('AbstractProjectManager and DefaultHydraniumScopeProvider scaling', () => {
   for (const size of [64, 128, 256]) {
      const manager = new ProjectProbe(size);
      const descriptions = Array.from({ length: size }, (_, i) =>
         makeFakeDescription(`Element${i}`, { tier: 'project', projectId: `p${i}`, documentUri: URI.parse(`file:///p${i}/model.x`) })
      );
      const global = new ScopeProbe(descriptions);
      const provider = new DefaultHydraniumScopeProvider(
         makeNoopLanguageServices({
            references: {},
            workspace: {},
            shared: {
               workspace: {
                  ProjectManager: manager,
                  DocumentBuilder: { onUpdate: () => Disposable.EMPTY, onBuildPhase: () => Disposable.EMPTY }
               }
            }
         })
      );
      const source = URI.parse('file:///p0/model.x');
      // Warm the scope and ownership caches before counting cache-hit work.
      const cached = provider.getProjectScope(source, global, 'Fake');
      manager.enumerated = 0;
      global.inspected = 0;
      for (let i = 0; i < size; i++) {
         expect(provider.getProjectScope(source, global, 'Fake')).toBe(cached);
      }
      expect(cached.getElement('Element0')).toBe(descriptions[0]);
      expect(cached.getElement('Element1')).toBeUndefined();
      expect(global.inspected).toBe(0);
      observations.push({ workload: 'warm scope lookups', size, projectsEnumerated: manager.enumerated });

      bench(
         `warm scope lookups at ${size}`,
         () => {
            for (let i = 0; i < size; i++) {
               provider.getProjectScope(source, global, 'Fake');
            }
         },
         options
      );

      const populate = (): void => {
         provider.clearScopeCaches();
         for (let i = 0; i < size; i++) {
            provider.getProjectScope(URI.parse(`file:///p${i}/model.x`), global, 'Fake');
         }
      };
      global.inspected = 0;
      populate();
      for (let i = 0; i < size; i++) {
         const scope = provider.getProjectScope(URI.parse(`file:///p${i}/model.x`), global, 'Fake');
         expect(scope.getAllElements().toArray()).toEqual([descriptions[i]]);
      }
      observations.push({ workload: 'cold project scopes', size, descriptionsInspected: global.inspected });
      bench(`cold project scopes at ${size}`, populate, options);

      const chain = new ProjectProbe(size, true);
      expect(new Set(chain.affected(`p${size - 1}`))).toEqual(new Set(descriptions.map((_, i) => `p${i}`)));
      observations.push({ workload: 'reverse ordered dependency chain', size, dependencyReads: chain.dependencyReads });
      bench(
         `reverse ordered dependency chain at ${size}`,
         () => {
            chain.affected(`p${size - 1}`);
         },
         options
      );
   }
});

afterAll(() => {
   for (const observation of observations) {
      process.stdout.write(`[project-scaling] ${JSON.stringify(observation)}\n`);
   }
});
