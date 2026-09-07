/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * The default node bucket label. Kept in its own module — separate from the
 * memlab-backed loader (load.mjs) — so the aggregation modules that need it
 * (aggregate/holders/cutpoints) do not transitively pull @memlab/heap-analysis
 * into the memlab-free `--diff` / `--help` paths.
 */

/**
 * Canonical bucket label for a node: a JS object is labelled by its
 * constructor name; everything else by its V8 type in parentheses.
 */
export function bucketLabel(node) {
   return node.type === 'object' ? node.name || '(anonymous object)' : `(${node.type})`;
}
