/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, test } from 'vitest';
import { ConflictError } from '../src/errors';
import { type BaseVersion, asModelVersion } from '../src/model-service/base-version';
import { type ConflictResolver, ForceConflictResolver, ReconcilingConflictResolver } from '../src/patch-merge';
import { type ReconcileWriteHooks, type VersionedModel, reconcileWrite } from '../src/reconcile-write';

interface Doc {
   readonly name: string;
   readonly note: string;
}

const BASE: Doc = { name: 'base', note: 'base' };
const OURS: Doc = { name: 'ours', note: 'base' };

interface Recorder {
   readonly writes: { model: Doc; baseVersion: BaseVersion }[];
   readonly unavailable: Doc[];
   readonly hooks: ReconcileWriteHooks<Doc>;
}

/** Hooks whose first `conflicts` writes raise a `ConflictError` and whose refetches return `refetches` in turn. */
function record(options: {
   conflicts: number;
   refetches?: (VersionedModel<Doc> | undefined)[];
   conflictResolver?: ConflictResolver;
   maxWrites?: number;
   withUnavailable?: boolean;
}): Recorder {
   const writes: { model: Doc; baseVersion: BaseVersion }[] = [];
   const unavailable: Doc[] = [];
   const refetches = [...(options.refetches ?? [])];
   const hooks: ReconcileWriteHooks<Doc> = {
      persist: async (model, baseVersion) => {
         writes.push({ model, baseVersion });
         if (writes.length <= options.conflicts) {
            throw new ConflictError('file:///a.x', asModelVersion(writes.length), writes.length + 1);
         }
      },
      refetch: async () => refetches.shift(),
      base: BASE,
      conflictResolver: options.conflictResolver ?? new ReconcilingConflictResolver(),
      ...(options.maxWrites === undefined ? {} : { maxWrites: options.maxWrites }),
      ...(options.withUnavailable === false
         ? {}
         : {
              onUnavailable: async (model: Doc) => {
                 unavailable.push(model);
              }
           })
   };
   return { writes, unavailable, hooks };
}

function theirs(note: string, version: number): VersionedModel<Doc> {
   return { model: { name: 'base', note }, baseVersion: asModelVersion(version) };
}

describe('reconcileWrite', () => {
   test('reports a first write that lands as persisted', async () => {
      const recorder = record({ conflicts: 0 });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toEqual({ status: 'persisted' });
      expect(recorder.writes).toEqual([{ model: OURS, baseVersion: 5 }]);
   });

   test("gates each merged write on its own refetch's version, and merges again when one conflicts", async () => {
      const recorder = record({ conflicts: 2, refetches: [theirs('first', 7), theirs('second', 9)] });

      const outcome = await reconcileWrite(OURS, asModelVersion(5), recorder.hooks);

      expect(outcome).toMatchObject({ status: 'merged', writes: 3 });
      expect(recorder.writes.map(write => write.baseVersion)).toEqual([5, 7, 9]);
      expect(recorder.writes[2].model).toEqual({ name: 'ours', note: 'second' });
   });

   test("writes a merge that refetched nothing based on 'any'", async () => {
      const recorder = record({ conflicts: 1, conflictResolver: new ForceConflictResolver() });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'merged', writes: 2 });
      expect(recorder.writes.map(write => write.baseVersion)).toEqual([5, 'any']);
   });

   test('drops the edit once maxWrites writes have conflicted', async () => {
      const recorder = record({ conflicts: Infinity, refetches: [theirs('first', 7)], maxWrites: 2 });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'dropped', writes: 2 });
      expect(recorder.writes).toHaveLength(2);
   });

   test('drops the edit after three conflicting writes when maxWrites is absent', async () => {
      const recorder = record({
         conflicts: Infinity,
         refetches: [theirs('first', 7), theirs('second', 9), theirs('third', 11), theirs('fourth', 13)]
      });

      const outcome = await reconcileWrite(OURS, asModelVersion(5), recorder.hooks);

      expect(outcome).toMatchObject({ status: 'dropped', writes: 3 });
      expect(outcome.status !== 'persisted' && outcome.conflict.baseVersion).toBe(3);
      expect(recorder.writes).toHaveLength(3);
   });

   test('hands an unavailable refetch to onUnavailable with the original model', async () => {
      const recorder = record({ conflicts: 1, refetches: [undefined] });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'unavailable', writes: 1 });
      expect(recorder.unavailable).toEqual([OURS]);
      expect(recorder.writes).toHaveLength(1);
   });

   test('leaves an unavailable edit unwritten without onUnavailable', async () => {
      const recorder = record({ conflicts: 1, refetches: [undefined], withUnavailable: false });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'unavailable' });
      expect(recorder.writes).toHaveLength(1);
   });

   test('reports a same-field collision as conflict without writing again', async () => {
      const recorder = record({
         conflicts: 1,
         refetches: [{ model: { name: 'foreign', note: 'base' }, baseVersion: asModelVersion(7) }]
      });

      expect(await reconcileWrite(OURS, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'conflict', writes: 1 });
      expect(recorder.writes).toHaveLength(1);
   });

   test('reports an empty edit as unchanged', async () => {
      const recorder = record({ conflicts: 1 });

      expect(await reconcileWrite(BASE, asModelVersion(5), recorder.hooks)).toMatchObject({ status: 'unchanged', writes: 1 });
   });

   test('re-throws an error that is not a conflict', async () => {
      const hooks: ReconcileWriteHooks<Doc> = {
         ...record({ conflicts: 0 }).hooks,
         persist: async () => {
            throw new Error('disk full');
         }
      };

      await expect(reconcileWrite(OURS, asModelVersion(5), hooks)).rejects.toThrow('disk full');
   });

   test('requires a base', () => {
      // Without one the intent is measured against itself, and a conflict ends unchanged with the edit unwritten.
      // @ts-expect-error `base` takes no `undefined`.
      const hooks: ReconcileWriteHooks<Doc> = { ...record({ conflicts: 0 }).hooks, base: undefined };

      expect(hooks.base).toBeUndefined();
   });
});
