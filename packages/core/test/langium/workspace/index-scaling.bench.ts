/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, bench, describe, expect } from 'vitest';
import { type AstNodeDescription, URI } from '@hydranium/langium';
import { DefaultHydraniumIndexManager } from '../../../src/langium/workspace/index-manager.js';
import { makeFakeDescription, makeNoopSharedServices } from '../../../src/testing/index.js';

/** Seed the index outside removal so the measured operation contains no parsing or fixture construction. */
class IndexProbe extends DefaultHydraniumIndexManager {
   seed(uri: URI, descriptions: AstNodeDescription[]): void {
      this.symbolIndex.set(uri.toString(), descriptions);
      this.addToElementsByName(uri.toString());
   }
}

const observations: object[] = [];
const options = { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 };

describe('DefaultHydraniumIndexManager removal scaling', () => {
   for (const size of [64, 128, 256]) {
      for (const variant of ['shared name across documents', 'repeated name within document'] as const) {
         let reads = 0;
         const uris = Array.from({ length: size }, (_, i) => URI.parse(`file:///element${i}.x`));
         const survivorUri = URI.parse('file:///survivor.x');
         const tracked = (uri: URI, path: string): AstNodeDescription => {
            const description = makeFakeDescription('Element', { documentUri: uri, path });
            Object.defineProperty(description, 'documentUri', {
               get: () => {
                  reads++;
                  return uri;
               }
            });
            return description;
         };
         const descriptions = uris.map((uri, i) => tracked(variant === 'shared name across documents' ? uri : uris[0], `/${i}`));
         const survivors = Array.from({ length: size }, (_, i) => tracked(survivorUri, `/${i}`));
         let manager: IndexProbe;
         const seed = (): void => {
            manager = new IndexProbe(makeNoopSharedServices({ workspace: {} }));
            if (variant === 'shared name across documents') {
               uris.forEach((uri, i) => manager.seed(uri, [descriptions[i]]));
            } else {
               manager.seed(uris[0], descriptions);
               manager.seed(survivorUri, survivors);
            }
            expect(manager.getElementsByName('Element')).toHaveLength(variant === 'shared name across documents' ? size : 2 * size);
            reads = 0;
         };
         const remove = (): void => {
            if (variant === 'shared name across documents') {
               uris.forEach(uri => manager.removeContent(uri));
            } else {
               manager.removeContent(uris[0]);
            }
         };
         seed();
         remove();
         const inspected = reads;
         expect(manager!.getElementsByName('Element')).toEqual(variant === 'shared name across documents' ? [] : survivors);
         observations.push({ workload: variant, size, descriptionUriReads: inspected });
         bench(`${variant} at ${size}`, remove, {
            ...options,
            setup: task => {
               // Vitest passes benchmark options to Tinybench. Per-iteration hooks belong to its task.
               task.opts.beforeEach = seed;
               task.opts.afterEach = () => {
                  expect(manager.getElementsByName('Element')).toEqual(variant === 'shared name across documents' ? [] : survivors);
               };
            }
         });
      }
   }
});

afterAll(() => {
   for (const observation of observations) {
      process.stdout.write(`[index-scaling] ${JSON.stringify(observation)}\n`);
   }
});
