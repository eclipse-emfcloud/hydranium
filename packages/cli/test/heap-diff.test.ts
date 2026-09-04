/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
// The analyzer ships as bundled ESM assets under heap-analysis/ (not the tsc lib);
// import the pure diff arithmetic directly. It is the CI regression gate (`--diff`),
// so it needs no snapshot or memlab and must be covered on its own.
// @ts-expect-error -- .mjs asset, no type declarations
import { diffAnalyses } from '../heap-analysis/heap/core/diff.mjs';

/** Build a minimal analysis JSON — only the fields diffAnalyses reads. */
function analysis(totalShallowBytes: number, concepts: unknown = {}, astByType: unknown = {}): unknown {
   return { totalShallowBytes, concepts, astByType };
}

describe('diffAnalyses (pure, CI-gating)', () => {
   it('flags a regression when total-shallow growth exceeds the threshold', () => {
      const diff = diffAnalyses(analysis(1000), analysis(1100), 0.05);
      expect(diff.total).toMatchObject({ base: 1000, cur: 1100, delta: 100 });
      expect(diff.total.growthPct).toBeCloseTo(0.1);
      expect(diff.regressed).toBe(true);
   });

   it('does not flag growth at or below the threshold (strict greater-than)', () => {
      // Exactly at the threshold is NOT a regression — the boundary a 0% gate relies on.
      expect(diffAnalyses(analysis(1000), analysis(1050), 0.05).regressed).toBe(false);
      expect(diffAnalyses(analysis(1000), analysis(1020), 0.05).regressed).toBe(false);
      // A 0% gate flags any positive growth.
      expect(diffAnalyses(analysis(1000), analysis(1001), 0).regressed).toBe(true);
      expect(diffAnalyses(analysis(1000), analysis(1000), 0).regressed).toBe(false);
   });

   it('treats a zero baseline as no growth (no divide-by-zero)', () => {
      const diff = diffAnalyses(analysis(0), analysis(500), 0.05);
      expect(diff.total.growthPct).toBe(0);
      expect(diff.regressed).toBe(false);
   });

   it('emits per-concept exclusive-retained deltas sorted by absolute delta, omitting unchanged', () => {
      const base = analysis(0, { CST: { exclusive: 100, shallow: 100 }, Range: { exclusive: 50 }, Stable: { exclusive: 10 } });
      const cur = analysis(0, { CST: { exclusive: 130, shallow: 130 }, Range: { exclusive: 10 }, Stable: { exclusive: 10 } });
      const diff = diffAnalyses(base, cur, 0.05);
      // Range delta -40 (abs 40) sorts before CST delta +30; Stable is unchanged and dropped.
      expect(diff.concepts.map((row: { key: string }) => row.key)).toEqual(['Range', 'CST']);
      expect(diff.concepts.find((row: { key: string }) => row.key === 'CST')).toMatchObject({ base: 100, cur: 130, delta: 30 });
   });

   it('counts a new concept from zero and a removed concept as negative', () => {
      const diff = diffAnalyses(analysis(0, { Old: { exclusive: 40 } }), analysis(0, { New: { exclusive: 25 } }), 0.05);
      expect(diff.concepts.find((row: { key: string }) => row.key === 'New')).toMatchObject({ base: 0, cur: 25, delta: 25 });
      expect(diff.concepts.find((row: { key: string }) => row.key === 'Old')).toMatchObject({ base: 40, cur: 0, delta: -40 });
   });

   it('emits astByType count deltas and omits unchanged types', () => {
      const diff = diffAnalyses(analysis(0, {}, { TypeOne: 10, TypeTwo: 5 }), analysis(0, {}, { TypeOne: 12, TypeTwo: 5 }), 0.05);
      expect(diff.ast).toEqual([{ key: 'TypeOne', base: 10, cur: 12, delta: 2 }]);
   });

   it('echoes the threshold used', () => {
      expect(diffAnalyses(analysis(1000), analysis(1000), 0.03).thresholdPct).toBe(0.03);
   });
});
