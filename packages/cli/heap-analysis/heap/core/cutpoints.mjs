/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Cut points (heap-agnostic): lightweight SOLE owners of large subtrees.
 *
 * A node with tiny shallow size but huge retained size dominates a big subtree
 * it alone keeps alive -- severing the few references to it frees the whole
 * subtree. These are the highest-leverage things to drop. Few referrers = easy
 * to cut; many referrers = the retained subtree is shared and won't free.
 */
import { bucketLabel } from './bucket-label.mjs';

/**
 * @param {import('@memlab/core').IHeapSnapshot} heap
 * @param {string[]} labelOfIndex per-nodeIndex concept label (for readable names)
 * @param {{ minRetained?: number, maxShallow?: number, topN?: number }} [opts]
 */
export function findCutPoints(heap, labelOfIndex, { minRetained = 512 * 1024, maxShallow = 4096, topN = 20 } = {}) {
   const candidates = [];
   heap.nodes.forEach(node => {
      // Skip the GC super-root(s): they "retain everything" but aren't a cut point.
      if (node.type === 'synthetic') {
         return;
      }
      if (node.retainedSize >= minRetained && node.self_size <= maxShallow) {
         // The shortest-path-to-root edge names what holds this node — `Holder.edge`
         // — so otherwise-identical cut points (e.g. several `Map`s) are told apart.
         const pathEdge = node.pathEdge;
         const from = pathEdge?.fromNode;
         const via = pathEdge ? (pathEdge.is_index ? '[]' : pathEdge.name_or_index) : '';
         const retainer = from ? `${labelOfIndex[from.nodeIndex] || bucketLabel(from)}.${via}` : '';
         candidates.push({
            node,
            label: labelOfIndex[node.nodeIndex] || bucketLabel(node),
            shallow: node.self_size,
            retained: node.retainedSize,
            referrers: node.numOfReferrers,
            retainer
         });
      }
   });
   candidates.sort((a, b) => b.retained - a.retained);
   return candidates.slice(0, topN);
}
