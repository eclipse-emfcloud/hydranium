/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type Disposable, DisposableCollection, isPromiseLike, type MaybePromise } from '../src/util';

function tracked(log: string[], label: string, throwOnDispose = false): Disposable {
   return {
      dispose: () => {
         log.push(label);
         if (throwOnDispose) {
            throw new Error(`dispose(${label}) failed`);
         }
      }
   };
}

describe('DisposableCollection', () => {
   it('push() returns the added disposable for chaining', () => {
      const collection = new DisposableCollection();
      const d = tracked([], 'a');
      expect(collection.push(d)).toBe(d);
   });

   it('dispose() drains all in LIFO order', () => {
      const collection = new DisposableCollection();
      const log: string[] = [];
      collection.push(tracked(log, 'A'));
      collection.push(tracked(log, 'B'));
      collection.push(tracked(log, 'C'));
      collection.dispose();
      expect(log).toEqual(['C', 'B', 'A']);
   });

   it('dispose() is idempotent — second call is a no-op', () => {
      const collection = new DisposableCollection();
      const log: string[] = [];
      collection.push(tracked(log, 'A'));
      collection.dispose();
      collection.dispose();
      expect(log).toEqual(['A']);
   });

   it('disposed getter reflects state — false before, true after dispose()', () => {
      const collection = new DisposableCollection();
      expect(collection.disposed).toBe(false);
      collection.dispose();
      expect(collection.disposed).toBe(true);
   });

   it('push() after dispose() immediately disposes the late-arriving item', () => {
      const collection = new DisposableCollection();
      const log: string[] = [];
      collection.dispose();
      collection.push(tracked(log, 'late'));
      expect(log).toEqual(['late']);
   });

   it('push() after dispose() does not add to the (drained) internal array', () => {
      const collection = new DisposableCollection();
      collection.dispose();
      collection.push(tracked([], 'late'));
      // Internal state — verified via the protected `disposables` field to assert
      // the collection does not retain a reference to a disposable that was
      // already torn down. Cast to access the protected member.
      const internal = collection as unknown as { disposables: Disposable[] };
      expect(internal.disposables.length).toBe(0);
   });

   it('a throwing disposable does not strand subsequent disposables in the drain', () => {
      const collection = new DisposableCollection();
      const log: string[] = [];
      collection.push(tracked(log, 'A'));
      collection.push(tracked(log, 'B', /* throwOnDispose */ true));
      collection.push(tracked(log, 'C'));
      // LIFO: C disposes first, then B (which throws), then A. The thrower
      // must not prevent A from running.
      expect(() => collection.dispose()).not.toThrow();
      expect(log).toEqual(['C', 'B', 'A']);
   });
});

describe('isPromiseLike', () => {
   it('returns true for native Promise', () => {
      expect(isPromiseLike(Promise.resolve(1))).toBe(true);
   });

   it('returns true for any thenable', () => {
      const thenable: PromiseLike<number> = { then: (onfulfilled?) => (onfulfilled ? onfulfilled(0) : undefined) as PromiseLike<never> };
      expect(isPromiseLike(thenable)).toBe(true);
   });

   it('returns false for plain values', () => {
      expect(isPromiseLike(0)).toBe(false);
      expect(isPromiseLike('text')).toBe(false);
      expect(isPromiseLike(true)).toBe(false);
      expect(isPromiseLike({ value: 1 } as MaybePromise<unknown>)).toBe(false);
      expect(isPromiseLike([] as MaybePromise<unknown>)).toBe(false);
   });

   it('returns false for null and undefined', () => {
      expect(isPromiseLike(null as unknown as MaybePromise<void>)).toBe(false);
      expect(isPromiseLike(undefined as unknown as MaybePromise<void>)).toBe(false);
   });

   it('preserves the sync fast path — no microtask when value is sync', async () => {
      // A microtask queued BEFORE the expression is what makes the ordering
      // observable at all: two `order.push` statements in one async function
      // with nothing contending for the queue run in sequence whether or not
      // the expression yielded, so the yield has to be raced against a
      // continuation that is already waiting. A guard that wrongly took the
      // `await` branch would let this one run first.
      const order: string[] = [];
      queueMicrotask(() => order.push('contender'));
      const syncValue: MaybePromise<number> = 42;
      const resolved = isPromiseLike(syncValue) ? await syncValue : syncValue;
      order.push(`resolved:${resolved}`);
      await Promise.resolve();
      expect(order).toEqual(['resolved:42', 'contender']);
   });

   it('awaits the async branch', async () => {
      const asyncValue: MaybePromise<number> = Promise.resolve(7);
      const resolved = isPromiseLike(asyncValue) ? await asyncValue : asyncValue;
      expect(resolved).toBe(7);
   });
});
