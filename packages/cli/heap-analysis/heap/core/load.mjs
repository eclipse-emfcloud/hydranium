/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Heap-agnostic loader. Wraps memlab's getFullHeapFromFile, which parses the
 * .heapsnapshot and computes dominators + retained sizes natively.
 *
 * Nothing in core/ knows about Langium or any adopter's model.
 */
import { getFullHeapFromFile } from '@memlab/heap-analysis';
import { progress } from './format.mjs';

const mb = bytes => bytes / (1024 * 1024);

/**
 * Load a snapshot and return the memlab heap plus light meta.
 * @param {string} file path to a .heapsnapshot
 * @param {(msg: string) => void} [log] timestamped progress sink (defaults to stderr)
 */
export async function loadHeap(file, log = progress) {
   const t0 = Date.now();
   log(`Loading ${file} ...`);
   const heap = await getFullHeapFromFile(file);
   const loadSeconds = (Date.now() - t0) / 1000;

   let totalShallow = 0;
   heap.nodes.forEach(node => {
      totalShallow += node.self_size;
   });

   const meta = {
      snapshot: file,
      nodeCount: heap.nodes.length,
      totalShallowBytes: totalShallow,
      totalShallowMb: Number(mb(totalShallow).toFixed(1)),
      loadSeconds: Number(loadSeconds.toFixed(1))
   };
   log(`Loaded ${meta.nodeCount} nodes, ${meta.totalShallowMb} MB shallow in ${meta.loadSeconds}s`);
   return { heap, meta };
}
