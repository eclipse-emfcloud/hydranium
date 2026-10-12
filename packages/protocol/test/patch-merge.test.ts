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

   test('reports already-applied with theirs when the refetch holds the value the user wrote', async () => {
      const result = await reconcileByPatchReplay({ name: 'Old' }, { name: 'New' }, async () => ({ name: 'New' }));

      expect(result).toEqual({ status: 'already-applied', theirs: { name: 'New' } });
   });

   test('reports already-applied when the refetch holds the key the user adds, at the same value', async () => {
      const base: { entity: Record<string, number> } = { entity: {} };

      const result = await reconcileByPatchReplay(base, { entity: { name: 1 } }, async () => ({ entity: { name: 1 } }));

      expect(result.status).toBe('already-applied');
   });

   test('reports already-applied when the refetch lacks the key the user removes', async () => {
      const result = await reconcileByPatchReplay({ name: 'X', note: 'N' }, { name: 'X' }, async () => ({ name: 'X' }));

      expect(result.status).toBe('already-applied');
   });

   test('reports already-applied when a foreign writer replaced the parent with an object lacking the removed key', async () => {
      // In JSON a replaced object reads as edits to its fields, so only the key the user removed decides.
      const result = await reconcileByPatchReplay<{ a: Record<string, number> }>({ a: { b: 1, c: 1 } }, { a: { c: 1 } }, async () => ({
         a: { z: 9 }
      }));

      expect(result).toEqual({ status: 'already-applied', theirs: { a: { z: 9 } } });
   });

   test('reports already-applied with the foreign edit when the refetch also changed another path', async () => {
      // The caller takes theirs as its new base; ours lacks the foreign edit.
      const theirs = { name: 'New', note: 'FOREIGN' };

      const result = await reconcileByPatchReplay({ name: 'Old', note: 'N' }, { name: 'New', note: 'N' }, async () => theirs);

      expect(result).toEqual({ status: 'already-applied', theirs });
   });

   test('replays only the paths the refetch does not already hold', async () => {
      const result = await reconcileByPatchReplay({ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 1 }, async () => ({ a: 2, b: 1, c: 3 }));

      expect(result).toEqual({ status: 'merged', merged: { a: 2, b: 2, c: 3 } });
   });

   test('compares an array once however many ops run through it, so a bulk edit the refetch holds stays fast', async () => {
      // Compared once per op, 20,000 nodes take far longer than the test timeout.
      const base = { nodes: Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: i })) };
      const ours = { nodes: base.nodes.map(node => ({ x: node.x + 1, y: node.y + 1 })) };

      const result = await reconcileByPatchReplay(base, ours, async () => structuredClone(ours));

      expect(result.status).toBe('already-applied');
   });

   test('counts an array once however many elements are inserted into it, so a bulk insert stays fast', async () => {
      // Counted once per insert, 20,000 elements take far longer than the test timeout.
      const base = { nodes: Array.from({ length: 20_000 }, (_, i) => ({ id: `n${i}` })) };
      const ours = { nodes: [...base.nodes, ...Array.from({ length: 20_000 }, (_, i) => ({ id: `m${i}` }))] };

      const result = await reconcileByPatchReplay(base, ours, async () => ({ ...structuredClone(base), name: 'renamed' }));

      expect(result).toEqual({ status: 'merged', merged: { ...ours, name: 'renamed' } });
   });

   test('checks for inserts once however many arrays the patch inserts into, so a bulk insert across arrays stays fast', async () => {
      // Each key owns its own array, so every array is a separate outermost one.
      const keys = Array.from({ length: 40_000 }, (_, i) => `k${i}`);
      const base = Object.fromEntries(keys.map(key => [key, [`${key}-a`]]));
      const ours = Object.fromEntries(keys.map(key => [key, [`${key}-a`, `${key}-b`]]));

      // A refetch already holding every insert stops at the collision check, so the time is the agreement check's.
      const result = await reconcileByPatchReplay(base, ours, async () => structuredClone(ours));

      expect(result.status).toBe('conflict');
   });

   test('reports already-applied when the refetch holds the array the user removed a middle element from', async () => {
      const [first, second, third] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

      const result = await reconcileByPatchReplay({ items: [first, second, third] }, { items: [first, third] }, async () => ({
         items: [first, third]
      }));

      expect(result.status).toBe('already-applied');
   });

   test('reports conflict when the refetch lost a different element of the array the user removed one from', async () => {
      // By index, the user's `remove /items/2` finds no `/items/2` in theirs:
      // agreeing would keep the third element, which the user removed.
      const [first, second, third] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

      const result = await reconcileByPatchReplay({ items: [first, second, third] }, { items: [first, second] }, async () => ({
         items: [first, third]
      }));

      expect(result).toEqual({ status: 'conflict', theirs: { items: [first, third] } });
   });

   test("reports conflict when the refetch holds the user's change to one element and another change elsewhere in the array", async () => {
      const result = await reconcileByPatchReplay({ items: [{ x: 1 }, { y: 1 }] }, { items: [{ x: 2 }, { y: 1 }] }, async () => ({
         items: [{ x: 2 }, { y: 5 }]
      }));

      expect(result.status).toBe('conflict');
   });

   test('reports conflict rather than insert again into an array whose other edits the refetch holds', async () => {
      // Skipping `replace /items/0` and replaying `add /items/2` would make it [1, 1, 2, 2].
      const ours = { items: [1, 1, 2] };

      const result = await reconcileByPatchReplay({ items: [2, 1] }, ours, async () => ({ items: [1, 1, 2] }));

      expect(result.status).toBe('conflict');
   });

   test('reports conflict when the refetch lacks the object the user removes a key from', async () => {
      // A foreign writer deleted `a`; the user kept `a.c`.
      const result = await reconcileByPatchReplay({ a: { b: 1, c: 1 } }, { a: { c: 1 } }, async () => ({}));

      expect(result).toEqual({ status: 'conflict', theirs: {} });
   });

   test('reports conflict when the refetch omits the document the user removes a key from', async () => {
      // A multi-document refetch omits a secondary it could not read.
      const document = 'file:///a.x';
      const base = { primary: { name: 'P' }, secondaries: { [document]: { note: 'N', width: 1 } } };
      const ours = { primary: { name: 'P' }, secondaries: { [document]: { width: 1 } } };
      const theirs = { primary: { name: 'P' }, secondaries: {} };

      const result = await reconcileByPatchReplay(base, ours, async () => theirs);

      expect(result).toEqual({ status: 'conflict', theirs });
   });

   test('reports already-applied when the refetch lacks a removed key that names an Object.prototype member', async () => {
      const base: Record<string, number> = { constructor: 1, other: 1 };

      const result = await reconcileByPatchReplay(base, { other: 1 }, async () => ({ other: 1 }));

      expect(result.status).toBe('already-applied');
   });

   test('reports unavailable when the refetch yields nothing', async () => {
      const base = { entity: { name: 'X' } };
      const ours = { entity: { name: 'Y' } };

      const result = await reconcileByPatchReplay(base, ours, async () => undefined);

      expect(result.status).toBe('unavailable');
   });
});

describe('ReconcilingConflictResolver', () => {
   test('delegates to reconcileByPatchReplay and merges a disjoint foreign edit', async () => {
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

   test('delegates to reconcileByPatchReplay and reports a conflict on same-field divergence', async () => {
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
