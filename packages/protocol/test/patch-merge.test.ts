/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, test } from 'vitest';
import { applyPatch, compare } from 'fast-json-patch';
import { augmentWithTestOps, ForceConflictResolver, ReconcilingConflictResolver, reconcileByPatchReplay } from '../src/patch-merge';

/** Clone so applyPatch (mutateDocument default) does not touch the shared fixture. */
function clone<T>(value: T): T {
   return JSON.parse(JSON.stringify(value)) as T;
}

describe('augmentWithTestOps', () => {
   test('merges cleanly when the foreign writer touched a different path', () => {
      const baseline = { entity: { name: 'X', description: 'D' } };
      const attempted = { entity: { name: 'Y', description: 'D' } }; // user changed name
      const fresh = { entity: { name: 'X', description: 'FOREIGN' } }; // foreign changed description

      const augmented = augmentWithTestOps(baseline, compare(baseline, attempted));
      const result = applyPatch(clone(fresh), augmented, true);

      expect((result.newDocument as typeof fresh).entity.name).toBe('Y'); // user intent applied
      expect((result.newDocument as typeof fresh).entity.description).toBe('FOREIGN'); // foreign edit preserved
   });

   test('throws TEST_OPERATION_FAILED when the foreign writer changed the same path', () => {
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'Y' } }; // user
      const fresh = { entity: { name: 'Z' } }; // foreign changed the same field

      const augmented = augmentWithTestOps(baseline, compare(baseline, attempted));

      expect(() => applyPatch(clone(fresh), augmented, true)).toThrow(/Test operation failed|TEST_OPERATION_FAILED/);
   });

   test('guards remove ops against same-path divergence', () => {
      const baseline = { items: [{ id: 'a', v: 1 }] };
      const attempted = { items: [] as Array<{ id: string; v: number }> }; // user removed the item
      const fresh = { items: [{ id: 'a', v: 2 }] }; // foreign mutated the item being removed

      const augmented = augmentWithTestOps(baseline, compare(baseline, attempted));

      expect(() => applyPatch(clone(fresh), augmented, true)).toThrow();
   });

   test('leaves add ops unguarded (no test op prepended for a newly added path)', () => {
      const baseline = { items: [] as Array<{ id: string }> };
      const attempted = { items: [{ id: 'new' }] };

      const augmented = augmentWithTestOps(baseline, compare(baseline, attempted));

      expect(augmented.some(op => op.op === 'test')).toBe(false);
   });
});

describe('reconcileByPatchReplay', () => {
   test('reports no-op (and skips refetch) when the user made no change from baseline', async () => {
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'X' } };
      let refetched = false;

      const result = await reconcileByPatchReplay(baseline, attempted, async () => {
         refetched = true;
         return baseline;
      });

      expect(result.status).toBe('no-op');
      expect(refetched).toBe(false); // short-circuits before the refetch round-trip
   });

   test('merges the user edit onto fresh state when the foreign edit is on a different field', async () => {
      const baseline = { entity: { name: 'X', description: 'D' } };
      const attempted = { entity: { name: 'Y', description: 'D' } };
      const fresh = { entity: { name: 'X', description: 'FOREIGN' } };

      const result = await reconcileByPatchReplay(baseline, attempted, async () => fresh);

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y'); // user intent
         expect(result.merged.entity.description).toBe('FOREIGN'); // foreign edit kept
      }
      expect(fresh.entity.description).toBe('FOREIGN'); // refetched root not mutated
   });

   test('reports conflict with the fresh root when the foreign edit hit the same field', async () => {
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'Y' } };
      const fresh = { entity: { name: 'Z' } };

      const result = await reconcileByPatchReplay(baseline, attempted, async () => fresh);

      expect(result.status).toBe('conflict');
      if (result.status === 'conflict') {
         expect(result.fresh.entity.name).toBe('Z');
      }
   });

   test('reports unavailable when the refetch yields nothing', async () => {
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'Y' } };

      const result = await reconcileByPatchReplay(baseline, attempted, async () => undefined);

      expect(result.status).toBe('unavailable');
   });
});

describe('ReconcilingConflictResolver', () => {
   test('delegates to reconcileByPatchReplay — merges a disjoint foreign edit', async () => {
      const resolver = new ReconcilingConflictResolver();
      const baseline = { entity: { name: 'X', description: 'D' } };
      const attempted = { entity: { name: 'Y', description: 'D' } };
      const fresh = { entity: { name: 'X', description: 'FOREIGN' } };

      const result = await resolver.resolve(baseline, attempted, async () => fresh);

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y');
         expect(result.merged.entity.description).toBe('FOREIGN');
      }
   });

   test('delegates to reconcileByPatchReplay — reports conflict on same-field divergence', async () => {
      const resolver = new ReconcilingConflictResolver();
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'Y' } };
      const fresh = { entity: { name: 'Z' } };

      const result = await resolver.resolve(baseline, attempted, async () => fresh);

      expect(result.status).toBe('conflict');
   });
});

describe('ForceConflictResolver', () => {
   test('always merges the attempted state, ignoring baseline and refetch (last-writer-wins)', async () => {
      const resolver = new ForceConflictResolver();
      const baseline = { entity: { name: 'X' } };
      const attempted = { entity: { name: 'Y' } };
      let refetched = false;

      const result = await resolver.resolve(baseline, attempted, async () => {
         refetched = true;
         return { entity: { name: 'Z' } };
      });

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y'); // attempted wins, foreign 'Z' clobbered
      }
      expect(refetched).toBe(false); // no refetch, no guard
   });
});
