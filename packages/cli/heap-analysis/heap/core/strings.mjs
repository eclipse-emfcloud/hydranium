/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Duplicate-string analysis (heap-agnostic) — quantifies the interning lever.
 *
 * V8 does not intern most runtime strings, so the same value (a name, a $type
 * tag, a qualified id) can exist as many separate string nodes. Grouping string
 * nodes by value shows how much could be reclaimed by interning to one copy.
 *
 * Only plain `string` nodes are analysed: memlab exposes their value via
 * node.name. `concatenated string` (cons) nodes report a placeholder name, not
 * their materialized text, so they cannot be value-deduped here -- they are a
 * SEPARATE lever (compute the qualified/combined ids on demand instead of
 * building them), quantified by their bucket size in the concept table.
 */

/**
 * @param {import('@memlab/core').IHeapSnapshot} heap
 * @param {{ types?: string[], maxLen?: number }} [opts]
 *   types: which V8 string node types to include; maxLen: skip values longer
 *   than this as interning candidates (big unique blobs like source text).
 */
export function duplicateStrings(heap, { types = ['string'], maxLen = 512 } = {}) {
   const want = new Set(types);
   const byValue = new Map(); // value -> { count, size, type }
   let totalBytes = 0;
   let totalNodes = 0;
   let skippedLong = 0;

   heap.nodes.forEach(node => {
      if (!want.has(node.type)) {
         return;
      }
      const value = node.name;
      if (typeof value !== 'string') {
         return;
      }
      totalNodes++;
      totalBytes += node.self_size;
      if (value.length > maxLen) {
         skippedLong++;
         return;
      }
      const entry = byValue.get(value);
      if (entry) {
         entry.count++;
      } else {
         byValue.set(value, { count: 1, size: node.self_size, type: node.type });
      }
   });

   return { byValue, totalBytes, totalNodes, skippedLong };
}

/**
 * Reduce a byValue map to ranked duplicates with reclaimable bytes
 * (= (count - 1) * per-instance self_size, i.e. keep one copy).
 */
export function rankReclaimable(byValue) {
   const dups = [];
   let reclaimableTotal = 0;
   let duplicatedValues = 0;
   for (const [value, { count, size, type }] of byValue) {
      if (count > 1) {
         const reclaimable = (count - 1) * size;
         reclaimableTotal += reclaimable;
         duplicatedValues++;
         dups.push({ value, count, size, type, reclaimable });
      }
   }
   dups.sort((a, b) => b.reclaimable - a.reclaimable);
   return { dups, reclaimableTotal, duplicatedValues, distinctValues: byValue.size };
}
