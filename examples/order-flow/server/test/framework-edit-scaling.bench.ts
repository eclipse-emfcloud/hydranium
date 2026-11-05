/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { buildWorkspaceProgrammatically, DefaultIntegrityService, type IntegrityRun } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { DocumentState, type LangiumDocument, type Scope } from '@hydranium/langium';
import { NoopLogger } from '@hydranium/protocol';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, bench, describe, expect } from 'vitest';
import { isField } from '../src/language-server/ast.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { generateLargeWorkspace } from '../src/testing/large-workspace.js';

/** Includes real dependent relinks, in addition to discovering their targets. */
class TimedIntegrityService extends DefaultIntegrityService {
   relinkMs = 0;
   relinkCalls = 0;
   protected override async relinkDependents(document: LangiumDocument, run: IntegrityRun): Promise<void> {
      const start = performance.now();
      this.relinkCalls++;
      try {
         await super.relinkDependents(document, run);
      } finally {
         this.relinkMs += performance.now() - start;
      }
   }
}

const roots: string[] = [];
const observations: object[] = [];

describe('order-flow edits across projects', async () => {
   for (const projects of [3, 12]) {
      const root = mkdtempSync(join(tmpdir(), 'hydranium-edit-scaling-'));
      roots.push(root);
      const corpus = generateLargeWorkspace({ root, projects });
      const integrity: TimedIntegrityService[] = [];
      const tree = createOrderFlowServices(
         { ...NodeFileSystem },
         {
            extraSharedModules: [{ Logger: () => new NoopLogger() }],
            extraLanguageModules: [
               {
                  integrity: {
                     IntegrityService: services => {
                        const service = new TimedIntegrityService(services, { syncMode: 'editor' });
                        integrity.push(service);
                        return service;
                     }
                  }
               }
            ]
         }
      );
      let scopeQueries = 0;
      let scopeMs = 0;
      let descriptions = 0;
      const counted = new WeakSet<Scope>();
      for (const language of tree.shared.ServiceRegistry.all) {
         const provider = language.references.ScopeProvider;
         const getProjectScope = provider.getProjectScope.bind(provider);
         provider.getProjectScope = (uri, scope, type) => {
            if (!counted.has(scope)) {
               counted.add(scope);
               const all = scope.getAllElements.bind(scope);
               scope.getAllElements = () =>
                  all().map(description => {
                     descriptions++;
                     return description;
                  });
            }
            scopeQueries++;
            const start = performance.now();
            try {
               return getProjectScope(uri, scope, type);
            } finally {
               scopeMs += performance.now() - start;
            }
         };
      }
      await buildWorkspaceProgrammatically(tree.shared, root);
      const documents = tree.shared.workspace.LangiumDocuments.all.toArray();
      expect(documents).toHaveLength(corpus.documents);
      const targets = documents.filter(document => document.uri.path.endsWith('/entity-00.domain'));
      expect(targets).toHaveLength(projects);
      const store = tree.shared.workspace.TextDocuments;
      const builder = tree.shared.workspace.DocumentBuilder;
      const texts = targets.map(document => readFileSync(document.uri.fsPath, 'utf8'));
      targets.forEach((document, i) =>
         store.notifyDidOpenTextDocument({
            textDocument: { uri: document.uri.toString(), languageId: 'domain', version: 1, text: texts[i] }
         })
      );
      await builder.update(
         targets.map(document => document.uri),
         []
      );
      tree.Domain.integrity.IntegrityService.register({
         id: 'bench-field-repair',
         nodeType: 'Field',
         phase: DocumentState.Linked,
         enforce: node => {
            if (isField(node) && node.name === 'benchRepair') {
               node.name = 'benchRepaired';
               return true;
            }
            return false;
         }
      });
      let version = 1;
      for (const workload of ['ordinary edit', 'single repair', 'repair batch'] as const) {
         let phase = 'warmup';
         let elapsedMs = 0;
         const changed = workload === 'repair batch' ? targets : targets.slice(0, 1);
         bench(
            `${workload} in ${projects} projects`,
            async () => {
               scopeQueries = 0;
               scopeMs = 0;
               descriptions = 0;
               integrity.forEach(service => {
                  service.relinkMs = 0;
                  service.relinkCalls = 0;
               });
               version++;
               const start = performance.now();
               changed.forEach((document, i) => {
                  const text = workload === 'ordinary edit' ? texts[i] : texts[i].replace('{', '{\n   benchRepair: String');
                  store.notifyDidChangeTextDocument({
                     textDocument: { uri: document.uri.toString(), version },
                     contentChanges: [{ text: `${text}\n// edit ${version}\n` }]
                  });
               });
               await builder.update(
                  changed.map(document => document.uri),
                  []
               );
               elapsedMs = performance.now() - start;
            },
            {
               iterations: 5,
               warmupIterations: 1,
               time: 0,
               warmupTime: 0,
               setup: (task, mode) => {
                  phase = mode;
                  task.opts.afterEach = () => {
                     const relinkCalls = integrity.reduce((sum, service) => sum + service.relinkCalls, 0);
                     expect(relinkCalls).toBe(workload === 'ordinary edit' ? 0 : changed.length);
                     for (const document of documents) {
                        expect(document.parseResult.parserErrors).toEqual([]);
                        expect(document.diagnostics?.filter(diagnostic => diagnostic.severity === 1) ?? []).toEqual([]);
                     }
                     for (const document of changed) {
                        expect(document.state).toBe(DocumentState.Validated);
                        if (workload !== 'ordinary edit') {
                           expect(store.get(document.uri.toString())?.getText()).toContain('benchRepaired');
                        }
                     }
                     if (phase === 'run') {
                        observations.push({
                           workload,
                           projects,
                           documents: corpus.documents,
                           elapsedMs,
                           scopeQueries,
                           scopeMs,
                           descriptions,
                           relinkCalls,
                           relinkMs: integrity.reduce((sum, service) => sum + service.relinkMs, 0)
                        });
                     }
                  };
               }
            }
         );
      }
   }
});

afterAll(() => {
   for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
   }
   for (const observation of observations) {
      process.stdout.write(`[framework-edit-scaling] ${JSON.stringify(observation)}\n`);
   }
});
