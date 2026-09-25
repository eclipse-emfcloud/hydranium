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
      const base = { entity: { name: 'X', description: 'D' } };
      const ours = { entity: { name: 'Y', description: 'D' } }; // user changed name
      const theirs = { entity: { name: 'X', description: 'FOREIGN' } }; // foreign changed description

      const augmented = augmentWithTestOps(base, compare(base, ours));
      const result = applyPatch(clone(theirs), augmented, true);

      expect((result.newDocument as typeof theirs).entity.name).toBe('Y'); // user intent applied
      expect((result.newDocument as typeof theirs).entity.description).toBe('FOREIGN'); // foreign edit preserved
   });

   test('throws TEST_OPERATION_FAILED when the foreign writer changed the same path', () => {
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } }; // user
      const theirs = { entity: { name: 'Z' } }; // foreign changed the same field

      const augmented = augmentWithTestOps(base, compare(base, ours));

      expect(() => applyPatch(clone(theirs), augmented, true)).toThrow(/Test operation failed|TEST_OPERATION_FAILED/);
   });

   test('guards remove ops against same-path divergence', () => {
      const base = { items: [{ id: 'a', v: 1 }] };
      const ours = { items: [] as Array<{ id: string; v: number }> }; // user removed the item
      const theirs = { items: [{ id: 'a', v: 2 }] }; // foreign mutated the item being removed

      const augmented = augmentWithTestOps(base, compare(base, ours));

      expect(() => applyPatch(clone(theirs), augmented, true)).toThrow();
   });

   test('leaves add ops unguarded (no test op prepended for a newly added path)', () => {
      const base = { items: [] as Array<{ id: string }> };
      const ours = { items: [{ id: 'new' }] };

      const augmented = augmentWithTestOps(base, compare(base, ours));

      expect(augmented.some(op => op.op === 'test')).toBe(false);
   });
});

describe('reconcileByPatchReplay', () => {
   test('reports no-op (and skips refetch) when the user made no change from base', async () => {
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'X' } };
      let refetched = false;

      const result = await reconcileByPatchReplay(base, ours, async () => {
         refetched = true;
         return base;
      });

      expect(result.status).toBe('no-op');
      expect(refetched).toBe(false); // short-circuits before the refetch round-trip
   });

   test('merges the user edit onto theirs when the foreign edit is on a different field', async () => {
      const base = { entity: { name: 'X', description: 'D' } };
      const ours = { entity: { name: 'Y', description: 'D' } };
      const theirs = { entity: { name: 'X', description: 'FOREIGN' } };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y'); // user intent
         expect(result.merged.entity.description).toBe('FOREIGN'); // foreign edit kept
      }
      expect(theirs.entity.description).toBe('FOREIGN'); // refetched root not mutated
   });

   test('reports conflict with theirs when the foreign edit hit the same field', async () => {
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } };
      const theirs = { entity: { name: 'Z' } };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
      if (result.status === 'conflict') {
         expect(result.theirs.entity.name).toBe('Z');
      }
   });

   test('reports conflict when the foreign writer appended the same element the user appends', async () => {
      // Replayed, the append would insert the element a second time.
      const base = { items: [{ id: 'a' }] };
      const ours = { items: [{ id: 'a' }, { id: 'b' }] };
      const theirs = { items: [{ id: 'a' }, { id: 'b' }] };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
   });

   test('reports conflict when the foreign writer appended the same element with its keys in another order', async () => {
      const base = { items: [{ id: 'a', v: 1 }] };
      const ours = {
         items: [
            { id: 'a', v: 1 },
            { id: 'b', v: 2 }
         ]
      };
      const theirs = {
         items: [
            { id: 'a', v: 1 },
            { v: 2, id: 'b' }
         ]
      };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
   });

   test('reports conflict when the foreign writer appended the same element with an undefined-valued key', async () => {
      const base = { items: [{ id: 'a' }] };
      const ours = { items: [{ id: 'a' }, { id: 'b' }] };
      const theirs = { items: [{ id: 'a' }, { id: 'b', note: undefined }] };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
   });

   test('merges an insert beside a different element the foreign writer inserted into the same array', async () => {
      const base = { items: [{ id: 'a' }] };
      const ours = { items: [{ id: 'a' }, { id: 'b' }] };
      const theirs = { items: [{ id: 'a' }, { id: 'c' }] };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result).toEqual({ status: 'merged', merged: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
   });

   test('reports conflict when the foreign writer added the key the user adds', async () => {
      // Replayed, the `add` would replace the foreign value.
      const base: { entity: Record<string, number> } = { entity: {} };
      const ours = { entity: { name: 1 } };
      const theirs = { entity: { name: 2 } };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
   });

   test('merges an added key beside a different key the foreign writer added', async () => {
      const base: { entity: Record<string, number> } = { entity: {} };
      const ours = { entity: { name: 1 } };
      const theirs = { entity: { other: 2 } };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result).toEqual({ status: 'merged', merged: { entity: { other: 2, name: 1 } } });
   });

   test('reports unavailable when the refetch yields nothing', async () => {
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } };

      const result = await reconcileByPatchReplay(base, ours, async () => undefined);

      expect(result.status).toBe('unavailable');
   });
});

describe('ReconcilingConflictResolver', () => {
   test('delegates to reconcileByPatchReplay — merges a disjoint foreign edit', async () => {
      const resolver = new ReconcilingConflictResolver();
      const base = { entity: { name: 'X', description: 'D' } };
      const ours = { entity: { name: 'Y', description: 'D' } };
      const theirs = { entity: { name: 'X', description: 'FOREIGN' } };

      const result = await resolver.resolve(base, ours, async () => theirs);

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y');
         expect(result.merged.entity.description).toBe('FOREIGN');
      }
   });

   test('delegates to reconcileByPatchReplay — reports conflict on same-field divergence', async () => {
      const resolver = new ReconcilingConflictResolver();
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } };
      const theirs = { entity: { name: 'Z' } };

      const result = await resolver.resolve(base, ours, async () => theirs);

      expect(result.status).toBe('conflict');
   });
});

describe('ForceConflictResolver', () => {
   test('always merges ours, ignoring base and refetch (last-writer-wins)', async () => {
      const resolver = new ForceConflictResolver();
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } };
      let refetched = false;

      const result = await resolver.resolve(base, ours, async () => {
         refetched = true;
         return { entity: { name: 'Z' } };
      });

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
         expect(result.merged.entity.name).toBe('Y'); // ours wins, foreign 'Z' clobbered
      }
      expect(refetched).toBe(false); // no refetch, no guard
   });
});
