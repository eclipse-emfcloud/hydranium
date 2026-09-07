/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The large-workspace generator's contract, asserted at a **small** size.
 *
 * The fixture itself is generated on demand and gitignored, so nothing in the
 * gate builds the full corpus. What has to stay true regardless of size is the
 * generator's agreement with the three grammars, and that is what rots: a
 * grammar change makes an emitted construct invalid, the corpus keeps
 * generating, and the next perf run measures a workspace the server never
 * linked. Running the generator small on every `npm test` is what keeps it
 * honest — there is no `check:` script for it, because a stale corpus on disk
 * cannot break a build and a gate over a generated artefact was the wrong shape
 * here.
 *
 * The build-and-link case goes through `validateWorkspace`, which is the exact
 * function `hydranium-cli validate` drives. That is deliberate: the fixture's
 * stated acceptance is "`validate` reports zero errors over the generated root",
 * so the automated small-size guard must not build by a different entry than
 * the manual full-size run — a generator defect that only the eager path
 * catches would otherwise pass here and fail there.
 *
 * Three projects rather than two, because two only produces the hub edge
 * (`requires gen-core`). The third is the first to carry the chain edge as
 * well, which is what makes `requires` a graph the project-scope filter walks
 * rather than a star it resolves in one hop.
 */

import { buildWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem, validateWorkspace } from '@hydranium/core/node';
import { type AstNode, AstUtils, URI } from '@hydranium/langium';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
   type Declaration,
   type DomainModel,
   type LayoutModel,
   type ProcessModel,
   isEntity,
   isTask,
   isWrite
} from '../src/language-server/ast.js';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { GENERATED_MARKER_FILE, generateLargeWorkspace, type LargeWorkspaceSummary } from '../src/testing/large-workspace.js';

/** The small size every case runs at. */
const SMALL = { projects: 3, entities: 4, processes: 3, seed: 4711 } as const;

/** The counts {@link SMALL} must produce, derived by hand from the documented rules. */
const EXPECTED = {
   // 3 projects × (1 descriptor + 4 members)
   domain: 15,
   // 3 projects × 3 processes
   process: 9,
   // 3 projects × (3 - 1), the last process of each staying unpositioned
   layout: 6,
   total: 30,
   // plus the stdlib virtual document
   documents: 31
} as const;

const scratchRoots: string[] = [];

/** A fresh throwaway root, remembered for teardown. */
function scratchRoot(label: string): string {
   const root = mkdtempSync(path.join(tmpdir(), `order-flow-large-${label}-`));
   scratchRoots.push(root);
   return root;
}

/** Every file under `directory`, keyed by its root-relative POSIX path. */
function readTree(directory: string): Map<string, string> {
   const contents = new Map<string, string>();
   const walk = (current: string): void => {
      for (const entry of readdirSync(current).sort()) {
         const absolute = path.join(current, entry);
         if (statSync(absolute).isDirectory()) {
            walk(absolute);
         } else {
            contents.set(path.relative(directory, absolute).split(path.sep).join('/'), readFileSync(absolute, 'utf8'));
         }
      }
   };
   walk(directory);
   return contents;
}

/** Model-file tally by extension, read off the directory rather than off the summary. */
function countByExtension(directory: string): Record<string, number> {
   const counts: Record<string, number> = { '.domain': 0, '.process': 0, '.layout': 0 };
   for (const file of readTree(directory).keys()) {
      const extension = path.extname(file);
      if (extension in counts) {
         counts[extension] += 1;
      }
   }
   return counts;
}

afterAll(() => {
   for (const root of scratchRoots) {
      rmSync(root, { recursive: true, force: true });
   }
});

describe('large-workspace generator — shape', () => {
   let summary: LargeWorkspaceSummary;
   let root: string;

   beforeAll(() => {
      root = scratchRoot('shape');
      summary = generateLargeWorkspace({ root, ...SMALL });
   });

   it('writes the documented number of files per extension', () => {
      expect(summary.files).toEqual({
         domain: EXPECTED.domain,
         process: EXPECTED.process,
         layout: EXPECTED.layout,
         total: EXPECTED.total
      });
      expect(summary.documents).toBe(EXPECTED.documents);
      // Off the filesystem too: the summary is the generator's own claim, and a
      // writer that skipped a file would report the count it intended to write.
      expect(countByExtension(root)).toEqual({
         '.domain': EXPECTED.domain,
         '.process': EXPECTED.process,
         '.layout': EXPECTED.layout
      });
   });

   it('gives every project a descriptor and marks the corpus as generated', () => {
      const files = readTree(root);
      expect(files.has(GENERATED_MARKER_FILE)).toBe(true);
      expect(files.get('gen-core/gen-core.domain')).toContain('project gen-core\n');
      expect(files.get('gen-app1/gen-app1.domain')).toContain('project gen-app1 requires gen-core\n');
      // The third project is the first with two edges: the hub plus the chain.
      expect(files.get('gen-app2/gen-app2.domain')).toContain('project gen-app2 requires gen-core, gen-app1\n');
   });

   it('refuses to overwrite a directory it did not generate', () => {
      const foreign = scratchRoot('foreign');
      writeFileSync(path.join(foreign, 'precious.txt'), 'not mine to delete');

      expect(() => generateLargeWorkspace({ root: foreign, ...SMALL })).toThrow(/Refusing to overwrite/);
      expect(readTree(foreign).has('precious.txt')).toBe(true);
   });
});

describe('large-workspace generator — determinism', () => {
   it('reproduces the corpus byte for byte at the same seed, and changes it at another', () => {
      const first = readTree(generateLargeWorkspace({ root: scratchRoot('seed-a'), ...SMALL }).root);
      const second = readTree(generateLargeWorkspace({ root: scratchRoot('seed-b'), ...SMALL }).root);
      const other = readTree(generateLargeWorkspace({ root: scratchRoot('seed-c'), ...SMALL, seed: SMALL.seed + 1 }).root);

      // Byte-identical, or the per-release number the fixture exists to produce
      // is not repeatable and two runs cannot be compared.
      expect([...second.entries()]).toEqual([...first.entries()]);
      // Same files, different content — which is what proves the seed is wired
      // to the content rather than ignored.
      expect([...other.keys()]).toEqual([...first.keys()]);
      expect([...other.entries()]).not.toEqual([...first.entries()]);
   });
});

describe('large-workspace generator — the server builds it', () => {
   let root: string;

   beforeAll(() => {
      root = scratchRoot('build');
      generateLargeWorkspace({ root, ...SMALL });
   });

   it('validates with no findings of any severity, through the CLI gate function', async () => {
      const result = await validateWorkspace({ createServices: () => createOrderFlowServices({ ...NodeFileSystem }), workspace: root });

      // Zero errors is the fixture's acceptance contract; the other severities
      // are asserted too so a warning-level regression cannot slip in as noise.
      expect(result.findings).toEqual([]);
      expect(result.counts).toEqual({ error: 0, warning: 0, info: 0, hint: 0 });
      expect(result.documents).toBe(EXPECTED.documents);
   });
});

describe('large-workspace generator — the edges it exists to exercise', () => {
   let shared: OrderFlowSharedServices;
   let root: string;

   beforeAll(async () => {
      root = scratchRoot('edges');
      generateLargeWorkspace({ root, ...SMALL });
      shared = createOrderFlowServices({ ...NodeFileSystem }).shared;
      await buildWorkspaceProgrammatically(shared, root);
   });

   /** The root node of a built document of the generated corpus, or a throw naming the path. */
   function rootOf<TRoot extends AstNode>(relativePath: string): TRoot {
      const document = shared.workspace.LangiumDocuments.getDocument(URI.file(path.join(root, relativePath)));
      if (!document) {
         throw new Error(`Document not loaded: ${relativePath}`);
      }
      return document.parseResult.value as TRoot;
   }

   it('declares one project per folder, with every requires naming a discovered project', () => {
      const projects = shared.workspace.ProjectManager;

      expect(
         projects
            .getProjects()
            .map(project => project.id)
            .sort()
      ).toEqual(['gen-app1', 'gen-app2', 'gen-core']);
      // Each descriptor's `requires` must name a project that exists — a
      // dependency on a project the manager never discovered contributes no
      // visibility and would silently narrow the corpus to per-project islands.
      for (const project of projects.getProjects()) {
         for (const dependency of project.dependencies ?? []) {
            expect(projects.getProjectById(dependency), `${project.id} requires unknown ${dependency}`).toBeDefined();
         }
      }
      expect([...projects.getVisibleProjects('gen-app2')].sort()).toEqual(['gen-app1', 'gen-app2', 'gen-core']);
   });

   it('resolves the cross-project field references across both requires edges', () => {
      const hubConsumer = rootOf<DomainModel>('gen-app1/entity-00.domain');
      const chainConsumer = rootOf<DomainModel>('gen-app2/entity-00.domain');

      // `shared` reaches the generated library project's `public` value type.
      expect(fieldTypeOf(hubConsumer, 'App1Entity0', 'shared')?.name).toBe('CoreShared');
      // `neighbour` reaches the PREVIOUS project's — the chain edge, which only
      // resolves because the descriptor requires it and the target is `public`.
      expect(fieldTypeOf(chainConsumer, 'App2Entity0', 'neighbour')?.name).toBe('App1Shared');
   });

   it('resolves the cross-grammar process references, subject and full effect chain', () => {
      const process = rootOf<ProcessModel>('gen-app1/flow-00.process');

      // `.process` → `.domain`: the subject entity lives in another grammar's
      // document, which a `.domain`-only corpus could never exercise. An
      // unresolved reference throws here, which IS the assertion.
      const subject = process.subject.ref;
      if (!subject) {
         throw new Error(`process ${process.name} did not resolve its subject`);
      }
      expect(isEntity(subject)).toBe(true);
      expect(AstUtils.getDocument(subject).uri.path.endsWith('.domain')).toBe(true);

      // The three-deep effect chain: entity, then a field of THAT entity, then a
      // literal of the enumeration the field is typed with.
      const effect = process.nodes.find(isTask)?.effects[0];
      if (!effect || !isWrite(effect)) {
         throw new Error(`process ${process.name} has no leading write effect`);
      }
      expect(effect.entity.ref?.name).toBe('App1Entity0');
      expect(effect.field.ref?.name).toBe('status');
      expect(effect.literal.ref?.name).toBe('NEW');
   });

   it('resolves the layout references into the process they are scoped to', () => {
      const layout = rootOf<LayoutModel>('gen-app1/flow-00.layout');
      const process = layout.process.ref;

      expect(process?.name).toBe('App1Flow0');
      // Every entry positions a node of THAT process; the layout scope provider
      // narrows the candidates, so a name from another process fails to link.
      for (const node of layout.nodes) {
         expect(node.flowNode.ref, `unresolved layout node in ${layout.name}`).toBeDefined();
         expect(process?.nodes).toContain(node.flowNode.ref);
      }
      // The last flow node is deliberately unpositioned.
      expect(layout.nodes.length).toBe((process?.nodes.length ?? 0) - 1);
   });
});

/** The declared type a named field of a named entity resolved to. */
function fieldTypeOf(model: DomainModel, entityName: string, fieldName: string): Declaration | undefined {
   const entity = model.declarations.find(declaration => declaration.name === entityName);
   if (!entity || !isEntity(entity)) {
      throw new Error(`No entity '${entityName}' in document`);
   }
   const field = entity.fields.find(candidate => candidate.name === fieldName);
   if (!field) {
      throw new Error(`No field '${fieldName}' on ${entityName}`);
   }
   return field.type.declared.ref;
}
