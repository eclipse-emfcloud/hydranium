/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What a scope extension costs the linker, by what it answers: nothing, one
 * constant description, every node of the reference's process, those
 * descriptions built once per process and pushed again for each reference, or
 * every node behind a cache key on the process.
 *
 * Each process has `size` tasks and `size` transitions, so `2 × size`
 * `FlowNode` references, each of which runs the extension unless a cache key
 * answers it. A link goes through the builder, so the times include its
 * phases after linking, which the variant without an extension shows. A
 * report-only signal, run with `npm run bench`; after the benches it writes,
 * per variant and size, the extension's calls and descriptions per link and
 * its share of the link time, so the time spent building descriptions shows
 * apart from the time the provider spends making scopes of them and looking
 * names up.
 */

import 'reflect-metadata';
import {
   buildWorkspaceProgrammatically,
   type HydraniumAstNodeDescriptionProvider,
   type ScopeExtensionContribution,
   type ScopeExtensionRegistry,
   type TieredAstNodeDescription
} from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { type AstNode, AstUtils, DocumentState, URI } from '@hydranium/langium';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { isProcessModel } from '../src/language-server/ast.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';

type Variant = 'no extension' | 'constant description' | 'whole process' | 'whole process, descriptions kept' | 'whole process, cache key';

const VARIANTS: readonly Variant[] = [
   'no extension',
   'constant description',
   'whole process',
   'whole process, descriptions kept',
   'whole process, cache key'
];
const SIZES = [250, 500, 1000, 2000];

const DOMAIN = `project bench

entity Order {
   reference : String
}
`;

function processText(size: number): string {
   const tasks = Array.from({ length: size }, (_, i) => `   task T${i}`);
   const transitions = Array.from({ length: size }, (_, i) => `   transition T${i} -> T${(i + 1) % size}`);
   return `process Big for Order {\n${tasks.join('\n')}\n\n${transitions.join('\n')}\n}\n`;
}

/** The extension's work during the last link. */
interface Tally {
   calls: number;
   descriptions: number;
   ms: number;
}

class BenchScopeContribution implements ScopeExtensionContribution {
   readonly tally: Tally = { calls: 0, descriptions: 0, ms: 0 };
   protected readonly kept = new WeakMap<readonly AstNode[], TieredAstNodeDescription[]>();
   /** Set when the language's services are created, before any link. */
   descriptionProvider?: HydraniumAstNodeDescriptionProvider;

   constructor(protected readonly variant: Exclude<Variant, 'no extension'>) {}

   registerScopeExtensions(registry: ScopeExtensionRegistry): void {
      registry.register({
         id: 'bench:flow-nodes',
         referenceTypes: ['FlowNode'],
         cacheKey:
            this.variant === 'whole process, cache key' ? context => AstUtils.getContainerOfType(context, isProcessModel) : undefined,
         addDescriptions: (context, _referenceType, document, accept) => {
            const start = performance.now();
            const process = AstUtils.getContainerOfType(context, isProcessModel);
            let added = 0;
            if (this.variant === 'constant description') {
               accept.local({ node: context, name: 'benchConstant', document });
               added = 1;
            } else if (process && (this.variant === 'whole process' || this.variant === 'whole process, cache key')) {
               for (const node of process.nodes) {
                  accept.local({ node, name: `extension${node.name}`, document });
               }
               added = process.nodes.length;
            } else if (process) {
               let descriptions = this.kept.get(process.nodes);
               if (descriptions === undefined) {
                  const provider = this.descriptionProvider;
                  if (!provider) {
                     throw new Error('The description provider was not set');
                  }
                  descriptions = process.nodes.map(node => provider.createLocal({ node, name: `extension${node.name}`, document }));
                  this.kept.set(process.nodes, descriptions);
               }
               for (const description of descriptions) {
                  accept.push(description);
               }
               added = process.nodes.length;
            }
            this.tally.calls++;
            this.tally.descriptions += added;
            this.tally.ms += performance.now() - start;
         }
      });
   }
}

interface Subject {
   relink(): Promise<void>;
   tally?: Tally;
}

async function subject(variant: Variant, size: number): Promise<Subject> {
   const contribution = variant === 'no extension' ? undefined : new BenchScopeContribution(variant);
   const root = fs.mkdtempSync(path.join(os.tmpdir(), 'order-flow-scope-bench-'));
   roots.push(root);
   fs.writeFileSync(path.join(root, 'bench.domain'), DOMAIN);
   fs.writeFileSync(path.join(root, 'big.process'), processText(size));
   const services = createOrderFlowServices(
      { ...NodeFileSystem },
      {
         extraLanguageModules: contribution
            ? [
                 {
                    references: {
                       scopes: {
                          bench: languageServices => {
                             contribution.descriptionProvider = languageServices.workspace.AstNodeDescriptionProvider;
                             return contribution;
                          }
                       }
                    }
                 }
              ]
            : []
      }
   );
   await buildWorkspaceProgrammatically(services.shared, root);
   const process = services.shared.workspace.LangiumDocuments.getDocument(URI.file(path.join(root, 'big.process')));
   if (!process) {
      throw new Error(`The ${size}-node process was not loaded`);
   }
   if (process.state < DocumentState.Linked || process.parseResult.parserErrors.length > 0) {
      throw new Error(`The ${size}-node process did not build: ${process.parseResult.parserErrors.map(error => error.message).join('; ')}`);
   }
   const builder = services.shared.workspace.DocumentBuilder;
   return {
      tally: contribution?.tally,
      async relink() {
         // A new list, as a reparse gives, so the hand-kept descriptions are not the previous link's.
         const model = process.parseResult.value;
         if (isProcessModel(model)) {
            model.nodes = [...model.nodes];
         }
         if (contribution) {
            Object.assign(contribution.tally, { calls: 0, descriptions: 0, ms: 0 });
         }
         // Through the builder, whose `Linked` phase drops what a cache key kept.
         builder.resetToState(process, DocumentState.ComputedScopes);
         await builder.build([process]);
      }
   };
}

/** Generated input, removed after the run. */
const roots: string[] = [];

/** Per variant and size: the extension's tally and the time of the last link. */
const observations: Array<{ variant: Variant; size: number; linkMs: number } & Partial<Tally>> = [];

for (const variant of VARIANTS) {
   describe(variant, async () => {
      for (const size of SIZES) {
         const target = await subject(variant, size);
         bench(
            `link a ${size}-node process`,
            async () => {
               const start = performance.now();
               await target.relink();
               const linkMs = performance.now() - start;
               const existing = observations.findIndex(entry => entry.variant === variant && entry.size === size);
               const entry = { variant, size, linkMs, ...target.tally };
               if (existing === -1) {
                  observations.push(entry);
               } else {
                  observations[existing] = entry;
               }
            },
            { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 }
         );
      }
   });
}

afterAll(() => {
   for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
   }
   for (const entry of observations) {
      const extension =
         entry.calls === undefined
            ? ''
            : ` extension: ${entry.calls} calls, ${entry.descriptions} descriptions, ${entry.ms?.toFixed(1)} ms;`;
      process.stdout.write(`[scope-extension] ${entry.variant} @ ${entry.size}:${extension} link ${entry.linkMs.toFixed(1)} ms\n`);
   }
});
