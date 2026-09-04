/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
// The analyzer ships as bundled ESM assets under heap-analysis/. attributeExclusiveRetained
// takes the flat per-node arrays (not a memlab heap), so the subtle dominator-attribution
// pass can be unit-tested directly without a snapshot.
// @ts-expect-error -- .mjs asset, no type declarations
import { attributeExclusiveRetained } from '../heap-analysis/heap/core/aggregate.mjs';

interface Arrays {
   selfSize: Float64Array;
   domIndex: Int32Array;
   labelOfIndex: string[];
}

/** Build the flat per-node arrays from a compact node list ({ self, dom, label }). */
function arrays(nodes: { self: number; dom: number; label: string }[]): Arrays {
   return {
      selfSize: Float64Array.from(nodes.map(node => node.self)),
      domIndex: Int32Array.from(nodes.map(node => node.dom)),
      labelOfIndex: nodes.map(node => node.label)
   };
}

const total = (byLabel: Map<string, number>): number => [...byLabel.values()].reduce((sum, value) => sum + value, 0);

describe('attributeExclusiveRetained (dominator attribution)', () => {
   it('attributes each node to its nearest dominating anchor and partitions the whole heap', () => {
      const graph = arrays([
         { self: 10, dom: -1, label: 'Root' }, // 0 GC root
         { self: 20, dom: 0, label: 'TypeOne' }, // 1 anchor
         { self: 5, dom: 1, label: 'string' }, // 2 dominated by TypeOne
         { self: 7, dom: 0, label: 'string' } // 3 dominated only by root
      ]);
      const exclusive = attributeExclusiveRetained(graph, new Set(['TypeOne']));
      expect(exclusive.get('TypeOne')).toBe(25); // its own 20 + the string it dominates
      expect(exclusive.get('(root/shared)')).toBe(17); // root's 10 + the unowned string's 7
      // Exclusive attribution is a non-overlapping partition: it sums to the shallow total.
      expect(total(exclusive)).toBe(42);
   });

   it('charges a node to the nearest anchor, not a farther ancestor anchor', () => {
      const graph = arrays([
         { self: 0, dom: -1, label: 'Root' }, // 0
         { self: 10, dom: 0, label: 'TypeOne' }, // 1 anchor
         { self: 8, dom: 1, label: 'TypeTwo' }, // 2 anchor, under TypeOne
         { self: 4, dom: 2, label: 'string' } // 3 under TypeTwo
      ]);
      const exclusive = attributeExclusiveRetained(graph, new Set(['TypeOne', 'TypeTwo']));
      expect(exclusive.get('TypeTwo')).toBe(12); // 8 + the string, the nearer anchor
      expect(exclusive.get('TypeOne')).toBe(10); // only its own self
   });

   it('survives a dominator cycle (self-dominating GC root) without hanging', () => {
      const graph = arrays([
         { self: 5, dom: 0, label: 'Root' }, // 0 dominates itself
         { self: 3, dom: 0, label: 'string' } // 1
      ]);
      const exclusive = attributeExclusiveRetained(graph, new Set(['Nonexistent']));
      expect(exclusive.get('(root/shared)')).toBe(8);
      expect(total(exclusive)).toBe(8);
   });

   it('lands every byte in (root/shared) when there are no anchors', () => {
      const graph = arrays([
         { self: 1, dom: -1, label: 'A' },
         { self: 2, dom: 0, label: 'B' },
         { self: 3, dom: 1, label: 'C' }
      ]);
      const exclusive = attributeExclusiveRetained(graph, new Set<string>());
      expect([...exclusive.keys()]).toEqual(['(root/shared)']);
      expect(exclusive.get('(root/shared)')).toBe(6);
   });
});
