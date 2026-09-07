/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Heap-agnostic aggregation primitives.
 *
 * Three distinct size views, deliberately kept separate because they answer
 * different questions and must never be conflated:
 *
 *  - SHALLOW (self_size): the one clean additive partition of the heap. Sums
 *    to 100%. Use this for "share of heap".
 *  - RETAINED, OVERLAPPING (node.retainedSize summed per bucket): the
 *    DevTools "Summary" number. OVERLAPS across buckets (a parent's retained
 *    includes its children, which are their own rows) -> never sum these rows.
 *  - RETAINED, EXCLUSIVE (dominator attribution): each byte attributed once to
 *    the nearest anchor that dominates it. Non-overlapping; partitions the heap
 *    among the anchors + "(root/shared)". This is the honest "how much frees if
 *    this concept goes away" number.
 */
import { bucketLabel } from './bucket-label.mjs';

/**
 * One pass: shallow + overlapping-retained + count per label.
 * Also returns flat typed arrays (indexed by node.nodeIndex) needed for the
 * dominator-attribution pass, so callers don't iterate the heap twice.
 *
 * @param {import('@memlab/core').IHeapSnapshot} heap
 * @param {(node: import('@memlab/core').IHeapNode) => string} [labelFn]
 *   maps a node to its bucket label (defaults to the heap-agnostic
 *   constructor/type label; the Langium layer passes a concept classifier)
 */
export function aggregateByBucket(heap, labelFn = bucketLabel) {
   const byBucket = new Map(); // label -> { count, shallow, retainedOverlapping }
   const nodeCount = heap.nodes.length;
   const selfSize = new Float64Array(nodeCount);
   const domIndex = new Int32Array(nodeCount).fill(-1);
   const labelOfIndex = new Array(nodeCount);

   heap.nodes.forEach(node => {
      const label = labelFn(node);
      const entry = byBucket.get(label) ?? { count: 0, shallow: 0, retainedOverlapping: 0 };
      entry.count++;
      entry.shallow += node.self_size;
      entry.retainedOverlapping += node.retainedSize;
      byBucket.set(label, entry);

      const idx = node.nodeIndex;
      selfSize[idx] = node.self_size;
      labelOfIndex[idx] = label;
      domIndex[idx] = node.dominatorNode ? node.dominatorNode.nodeIndex : -1;
   });

   return { byBucket, selfSize, domIndex, labelOfIndex };
}

/**
 * Non-overlapping retained attribution via the dominator tree.
 *
 * For every node, walk up its dominator chain to the first node whose bucket
 * label is in `anchors`; attribute the node's self_size there. Nodes with no
 * anchor ancestor land in "(root/shared)". The result partitions the entire
 * heap among anchors + "(root/shared)" with no double counting.
 *
 * Memoized per node index, so total work is ~O(nodeCount).
 *
 * @param {{selfSize: Float64Array, domIndex: Int32Array, labelOfIndex: string[]}} arrays
 * @param {Set<string>} anchors bucket labels treated as ownership boundaries
 */
export function attributeExclusiveRetained({ selfSize, domIndex, labelOfIndex }, anchors) {
   const nodeCount = selfSize.length;
   const ROOT_SHARED = -1;
   const UNVISITED = -2;
   const IN_PROGRESS = -3;
   const ownerOf = new Int32Array(nodeCount).fill(UNVISITED);

   // Resolve the owning anchor index for a node, memoizing the whole chain.
   // Robust against dominator-chain cycles (the synthetic GC root dominates
   // itself; any node still IN_PROGRESS when revisited is treated as root).
   const resolveOwner = startIdx => {
      const chain = [];
      let idx = startIdx;
      let owner = ROOT_SHARED;
      while (idx >= 0) {
         const memo = ownerOf[idx];
         if (memo === IN_PROGRESS) {
            break; // cycle -> root/shared
         }
         if (memo !== UNVISITED) {
            owner = memo; // already resolved; chain shares its owner
            break;
         }
         if (anchors.has(labelOfIndex[idx])) {
            ownerOf[idx] = idx; // anchor owns itself and the chain below it
            owner = idx;
            break;
         }
         ownerOf[idx] = IN_PROGRESS;
         chain.push(idx);
         idx = domIndex[idx];
      }
      for (const chainIdx of chain) {
         ownerOf[chainIdx] = owner;
      }
      return owner;
   };

   for (let i = 0; i < nodeCount; i++) {
      if (ownerOf[i] === UNVISITED) {
         resolveOwner(i);
      }
   }

   // Sum self_size into the owner's bucket label.
   const exclusiveByLabel = new Map();
   for (let i = 0; i < nodeCount; i++) {
      const owner = ownerOf[i];
      const label = owner === ROOT_SHARED ? '(root/shared)' : labelOfIndex[owner];
      exclusiveByLabel.set(label, (exclusiveByLabel.get(label) ?? 0) + selfSize[i]);
   }
   return exclusiveByLabel;
}

/**
 * Shortest retainer path from a node up to a GC root, using memlab's pathEdge
 * (the incoming edge on the shortest path to root). Returns a list of hops
 * [{ via, from }] from the node outward to the root.
 *
 * @param {import('@memlab/core').IHeapNode} node
 * @param {number} [maxDepth]
 */
export function shortestRetainerPath(node, maxDepth = 12) {
   const hops = [];
   let current = node;
   let depth = 0;
   while (current && current.pathEdge && depth < maxDepth) {
      const edge = current.pathEdge;
      const from = edge.fromNode;
      hops.push({
         via: edge.is_index ? `[${edge.name_or_index}]` : String(edge.name_or_index),
         from: from.type === 'object' ? from.name || '(object)' : `(${from.type})`
      });
      current = from;
      depth++;
   }
   return hops;
}
