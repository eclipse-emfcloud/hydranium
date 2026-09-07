/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Deterministic diff of two analysis JSONs (heap-agnostic). Pure arithmetic on
 * already-computed analyses -- no snapshot or source needed, so it is instant
 * and CI-safe. Baselines are the small JSON artifacts written by `--json`.
 */

/** Union the keys of two count/size maps and emit per-key deltas, sorted by |delta|. */
function deltaRows(baseMap = {}, curMap = {}, pick) {
   const keys = new Set([...Object.keys(baseMap), ...Object.keys(curMap)]);
   const rows = [];
   for (const key of keys) {
      const base = pick(baseMap[key]);
      const cur = pick(curMap[key]);
      if (base !== cur) {
         rows.push({ key, base, cur, delta: cur - base });
      }
   }
   rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
   return rows;
}

/**
 * @param {object} base baseline analysis JSON (from --json)
 * @param {object} cur current analysis JSON
 * @param {number} thresholdPct fraction of baseline total-shallow growth that
 *   counts as a regression (e.g. 0.05 = 5%)
 */
export function diffAnalyses(base, cur, thresholdPct) {
   const concepts = deltaRows(base.concepts, cur.concepts, e => e?.exclusive ?? 0);
   const conceptsShallow = deltaRows(base.concepts, cur.concepts, e => e?.shallow ?? 0);
   const ast = deltaRows(base.astByType, cur.astByType, v => v ?? 0);

   const baseTotal = base.totalShallowBytes ?? 0;
   const curTotal = cur.totalShallowBytes ?? 0;
   const totalDelta = curTotal - baseTotal;
   const growthPct = baseTotal ? totalDelta / baseTotal : 0;
   const regressed = growthPct > thresholdPct;

   return {
      concepts,
      conceptsShallow,
      ast,
      total: { base: baseTotal, cur: curTotal, delta: totalDelta, growthPct },
      thresholdPct,
      regressed
   };
}
