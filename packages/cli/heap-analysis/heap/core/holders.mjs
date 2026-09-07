/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * "What holds X" retainer evidence (heap-agnostic).
 *
 * For every node matching a target predicate, tally two complementary views:
 *   - dominators: the concept of each node's single dominatorNode -> who
 *     EXCLUSIVELY owns it ("if I cut one thing, what frees").
 *   - referrers: every incoming edge as `edgeName@holderLabel` -> ALL holders,
 *     including shared references. Multiplicity here is why cutting one holder
 *     can free little (e.g. CST held by parent CST AND $cstNode AND a description).
 *
 * Labels are taken from the caller-supplied per-node label array, so core stays
 * ignorant of what the labels mean; the caller groups them for display.
 */
import { bucketLabel } from './bucket-label.mjs';

/**
 * Profile holders for SEVERAL target groups in a SINGLE heap pass (loading the
 * snapshot is the only expensive step, so multiple --holders share one pass).
 *
 * @param {import('@memlab/core').IHeapSnapshot} heap
 * @param {string[]} labelOfIndex per-nodeIndex classification label
 * @param {Int32Array} domIndex per-nodeIndex dominator nodeIndex (-1 = root)
 * @param {Set<string>} targetGroups concept groups to profile
 * @param {(label: string) => string} groupOf collapse a label to its group
 * @returns {Map<string, {targetCount, targetRetained, dominators, referrers}>}
 */
export function holderProfiles(heap, labelOfIndex, domIndex, targetGroups, groupOf) {
   const results = new Map();
   for (const group of targetGroups) {
      results.set(group, { targetCount: 0, targetRetained: 0, dominators: new Map(), referrers: new Map() });
   }

   heap.nodes.forEach(node => {
      const idx = node.nodeIndex;
      const group = groupOf(labelOfIndex[idx]);
      const result = results.get(group);
      if (!result) {
         return;
      }
      result.targetCount++;
      result.targetRetained += node.retainedSize;

      const dIdx = domIndex[idx];
      const dLabel = dIdx >= 0 ? labelOfIndex[dIdx] : '(GC root)';
      result.dominators.set(dLabel, (result.dominators.get(dLabel) ?? 0) + 1);

      for (const edge of node.referrers) {
         // __proto__ is the V8 prototype chain, not meaningful ownership -- skip it.
         if (edge.name_or_index === '__proto__') {
            continue;
         }
         const from = edge.fromNode;
         const fromLabel = (from && labelOfIndex[from.nodeIndex]) || (from ? bucketLabel(from) : '(root)');
         const name = edge.is_index ? '[]' : edge.name_or_index;
         const key = `${name}@${fromLabel}`;
         result.referrers.set(key, (result.referrers.get(key) ?? 0) + 1);
      }
   });

   return results;
}

/** Regroup a tally Map's keys via a key-mapping function, summing collisions. */
export function regroupTally(tally, mapKey) {
   const out = new Map();
   for (const [key, count] of tally) {
      const grouped = mapKey(key);
      out.set(grouped, (out.get(grouped) ?? 0) + count);
   }
   return out;
}
