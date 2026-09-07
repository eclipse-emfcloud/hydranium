/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { applyPatch, compare, deepClone } from 'fast-json-patch';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reconcileByPatchReplay } from '../src/patch-merge';

/**
 * Generative companion to the example-based `patch-merge.test.ts`. Where those
 * tests pin a handful of hand-written shapes, these exercise the reconciliation
 * invariants over thousands of random JSON roots + edits, so a path-disjointness
 * or test-op-guard regression surfaces as a shrunk minimal counterexample.
 *
 * fast-check varies its seed per run (more coverage over time) and prints the
 * failing seed + path on a counterexample, so a failure reproduces from the
 * logged `seed` — the seed is deliberately NOT pinned here.
 *
 * Arbitraries are plain JSON, not grammar models: `reconcileByPatchReplay`
 * operates on `object`/JSON through `fast-json-patch`, so a random JSON object
 * plus random edits is the natural generator and keeps this suite pure and
 * grammar-agnostic (hence it lives in protocol's own `test/`).
 */

type JsonRecord = Record<string, unknown>;

/** JSON-stable scalar leaves only — no doubles/`undefined`, so `JSON.stringify` round-trips and `toEqual` is well-behaved. */
const leaf = fc.oneof(fc.string(), fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.boolean(), fc.constant(null));

/** Keys excluding prototype-pollution hazards so a random `add` can never corrupt the test harness. */
const safeKey = fc
   .string({ minLength: 1, maxLength: 5 })
   .filter(key => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');

/** Bounded recursive JSON value (depth/breadth capped to keep generation cheap). */
const recursiveJson = fc.letrec(tie => ({
   value: fc.oneof({ maxDepth: 3 }, leaf, tie('array'), tie('object')),
   array: fc.array(tie('value'), { maxLength: 4 }),
   object: fc.dictionary(safeKey, tie('value'), { maxKeys: 5 })
}));
const jsonValue = recursiveJson.value;
const jsonObject = fc.dictionary(safeKey, jsonValue, { maxKeys: 5 });

/**
 * An object sentinel used as the baseline value at every EDITED key. A leaf edit
 * (scalar) can never equal it, so each edit is guaranteed to be a real change
 * (no accidental `no-op`) and stays a `replace`/`add` — never silently a value
 * coincidence — without any fragile deep-equality precondition.
 */
const SENTINEL = (): JsonRecord => ({});

/** Each generated key carries a role (untouched filler / user-edited / foreign-edited) and the values it needs. */
const keyedSpecs = fc.uniqueArray(
   fc.record({
      key: safeKey,
      role: fc.constantFrom('filler', 'user', 'foreign'),
      fillerVal: jsonValue,
      editVal: leaf
   }),
   { selector: spec => spec.key, minLength: 2, maxLength: 12 }
);

describe('patch-merge property tests', () => {
   it('round-trip: applyPatch(source, compare(source, target)) equals target', () => {
      fc.assert(
         fc.property(jsonObject, jsonObject, (source, target) => {
            const patched = applyPatch(deepClone(source), compare(source, target), false, true).newDocument;
            expect(patched).toEqual(target);
         })
      );
   });

   it('disjoint foreign edit always merges and carries both intents', async () => {
      await fc.assert(
         fc.asyncProperty(keyedSpecs, async specs => {
            const userSpecs = specs.filter(spec => spec.role === 'user');
            const foreignSpecs = specs.filter(spec => spec.role === 'foreign');
            // Need at least one of each for the property to have teeth.
            fc.pre(userSpecs.length > 0 && foreignSpecs.length > 0);

            const baseline: JsonRecord = {};
            for (const spec of specs) {
               baseline[spec.key] = spec.role === 'filler' ? spec.fillerVal : SENTINEL();
            }
            const attempted = deepClone(baseline);
            for (const spec of userSpecs) {
               attempted[spec.key] = spec.editVal;
            }
            const fresh = deepClone(baseline);
            for (const spec of foreignSpecs) {
               fresh[spec.key] = spec.editVal;
            }
            // Both intents on disjoint paths: fresh with the user edits layered on top.
            const expected = deepClone(fresh);
            for (const spec of userSpecs) {
               expected[spec.key] = spec.editVal;
            }

            const outcome = await reconcileByPatchReplay(baseline, attempted, async () => deepClone(fresh));

            expect(outcome.status).toBe('merged');
            if (outcome.status === 'merged') {
               expect(outcome.merged).toEqual(expected);
            }
         })
      );
   });

   it('same-path divergence is reported as a conflict, not silently clobbered', async () => {
      const conflictScenario = fc.record({
         sharedKey: safeKey,
         userVal: leaf,
         foreignVal: leaf,
         others: fc.uniqueArray(fc.record({ key: safeKey, val: jsonValue }), { selector: other => other.key, maxLength: 8 })
      });

      await fc.assert(
         fc.asyncProperty(conflictScenario, async ({ sharedKey, userVal, foreignVal, others }) => {
            // Keep the collision on the shared key alone.
            fc.pre(!others.some(other => other.key === sharedKey));

            const baseline: JsonRecord = { [sharedKey]: SENTINEL() };
            for (const other of others) {
               baseline[other.key] = other.val;
            }
            // Both writers move the shared key off the baseline (object) sentinel to a scalar,
            // so the user op is a guarded `replace` and the foreign value trips its test op.
            const attempted = deepClone(baseline);
            attempted[sharedKey] = userVal;
            const fresh = deepClone(baseline);
            fresh[sharedKey] = foreignVal;

            const outcome = await reconcileByPatchReplay(baseline, attempted, async () => deepClone(fresh));

            expect(outcome.status).toBe('conflict');
            if (outcome.status === 'conflict') {
               expect(outcome.fresh).toEqual(fresh);
            }
         })
      );
   });

   it('idempotence: reconciling an unchanged root is a no-op and skips the refetch', async () => {
      await fc.assert(
         fc.asyncProperty(jsonObject, async baseline => {
            let refetched = false;
            const outcome = await reconcileByPatchReplay(baseline, deepClone(baseline), async () => {
               refetched = true;
               return baseline;
            });
            expect(outcome.status).toBe('no-op');
            expect(refetched).toBe(false);
         })
      );
   });

   it('convergence: a sequence of interleaved foreign + user edits loses no intent', async () => {
      const sequenceScenario = fc.uniqueArray(safeKey, { minLength: 2, maxLength: 12 }).chain(pool => {
         const keys = pool.slice(0, Math.floor(pool.length / 2) * 2);
         return fc.record({
            keys: fc.constant(keys),
            editVals: fc.array(leaf, { minLength: keys.length, maxLength: keys.length })
         });
      });

      await fc.assert(
         fc.asyncProperty(sequenceScenario, async ({ keys, editVals }) => {
            const pairCount = keys.length / 2;
            let server: JsonRecord = {};
            for (const key of keys) {
               server[key] = SENTINEL();
            }
            let userBaseline = deepClone(server);

            for (let i = 0; i < pairCount; i++) {
               const userKey = keys[2 * i];
               const foreignKey = keys[2 * i + 1];
               // A foreign writer commits to its own field, then the user replays their
               // edit (on a disjoint field) against the freshly-fetched server state.
               server[foreignKey] = editVals[2 * i + 1];
               const attempted = deepClone(userBaseline);
               attempted[userKey] = editVals[2 * i];
               const snapshot = deepClone(server);

               const outcome = await reconcileByPatchReplay(userBaseline, attempted, async () => snapshot);

               expect(outcome.status).toBe('merged');
               if (outcome.status !== 'merged') {
                  return;
               }
               server = outcome.merged;
               userBaseline = deepClone(outcome.merged);
            }

            // Every interleaved intent survived the full sequence — none lost, none duplicated.
            for (let i = 0; i < pairCount; i++) {
               expect(server[keys[2 * i]]).toEqual(editVals[2 * i]);
               expect(server[keys[2 * i + 1]]).toEqual(editVals[2 * i + 1]);
            }
         })
      );
   });
});
