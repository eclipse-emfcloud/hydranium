/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Registry, type RegistryItem } from '../../src/util/registry.js';

interface TestItem extends RegistryItem {
   readonly value: number;
}

describe('Registry', () => {
   describe('register', () => {
      it('stores items and reports them via has/get/size', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         registry.register({ id: 'b', value: 2 });

         expect(registry.size).toBe(2);
         expect(registry.has('a')).toBe(true);
         expect(registry.has('b')).toBe(true);
         expect(registry.has('c')).toBe(false);
         expect(registry.get('a')?.value).toBe(1);
         expect(registry.get('c')).toBeUndefined();
      });

      it('throws on duplicate ids — silent overwrite would mask programming errors', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });

         expect(() => registry.register({ id: 'a', value: 2 })).toThrow(/Duplicate registry id: 'a'/);
         expect(registry.get('a')?.value).toBe(1); // original preserved
      });

      it('returns a Disposable that removes its OWN item and leaves the rest registered', () => {
         const registry = new Registry<TestItem>();
         const disposable = registry.register({ id: 'a', value: 1 });
         registry.register({ id: 'b', value: 2 });

         expect(registry.size).toBe(2);
         disposable.dispose();
         // Two items, because a single-item fixture cannot tell "removed its own
         // item" from "emptied the registry" — both leave size 0.
         expect(registry.has('a')).toBe(false);
         expect(registry.has('b')).toBe(true);
         expect(registry.size).toBe(1);
      });

      it('a second dispose does not remove a re-registered item of the same id', () => {
         const registry = new Registry<TestItem>();
         const stale = registry.register({ id: 'a', value: 1 });
         stale.dispose();
         registry.register({ id: 'a', value: 2 });

         // The hazard an id-keyed handle carries, and the only shape in which a
         // repeat dispose is observable at all: idempotence alone follows from
         // `unregister` on an absent id, which is asserted separately.
         expect(() => stale.dispose()).not.toThrow();
         expect(registry.get('a')?.value).toBe(2);
         expect(registry.size).toBe(1);
      });
   });

   describe('unregister', () => {
      it('removes the item by id and returns true', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         expect(registry.unregister('a')).toBe(true);
         expect(registry.has('a')).toBe(false);
      });

      it('returns false when id is unknown', () => {
         const registry = new Registry<TestItem>();
         expect(registry.unregister('missing')).toBe(false);
      });

      it('allows the same id to be re-registered after removal', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         registry.unregister('a');

         expect(() => registry.register({ id: 'a', value: 2 })).not.toThrow();
         expect(registry.get('a')?.value).toBe(2);
      });
   });

   describe('all — iteration order', () => {
      it('preserves registration order when no priorities are set', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         registry.register({ id: 'b', value: 2 });
         registry.register({ id: 'c', value: 3 });

         expect(registry.all().map(item => item.id)).toEqual(['a', 'b', 'c']);
      });

      it('sorts by priority ascending', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'high', priority: 10, value: 1 });
         registry.register({ id: 'low', priority: -1, value: 2 });
         registry.register({ id: 'mid', priority: 5, value: 3 });

         expect(registry.all().map(item => item.id)).toEqual(['low', 'mid', 'high']);
      });

      it('returns equal-priority items in registration order', () => {
         // Pins the CONTRACT, not the mechanism. Registration order for ties is
         // the sort's stability, required since ES2019, so no fixture here can
         // distinguish a correct tie-break from a broken one and an assertion
         // claiming otherwise would be false.
         const registry = new Registry<TestItem>();
         registry.register({ id: 'first', priority: 0, value: 1 });
         registry.register({ id: 'second', priority: 0, value: 2 });
         registry.register({ id: 'third', priority: 0, value: 3 });

         expect(registry.all().map(item => item.id)).toEqual(['first', 'second', 'third']);
      });

      it('treats omitted priority as 0', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'no-prio', value: 1 });
         registry.register({ id: 'lower', priority: -1, value: 2 });
         registry.register({ id: 'higher', priority: 1, value: 3 });

         expect(registry.all().map(item => item.id)).toEqual(['lower', 'no-prio', 'higher']);
      });

      it('caches the sorted list — repeated calls without mutation return the same reference', () => {
         // Not an implementation detail: consumers use the array reference as a
         // cache key for indexes they derive from it, so a version of `all` that
         // built a fresh array per call would make every such index rebuild on
         // every read. This assertion is what keeps that from landing silently.
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         registry.register({ id: 'b', value: 2 });

         const first = registry.all();
         const second = registry.all();
         expect(first).toBe(second); // identity, not just equality
      });

      it('hands out a snapshot — a later register does not mutate an array already returned', () => {
         // The sorted list must be built from a COPY of the backing array. Sorting
         // `items` in place would make the cached snapshot and the backing array
         // the same object, so the next `register` would push into an array a
         // caller is still holding — and since sorting is idempotent and stable,
         // no ordering assertion can see that aliasing.
         const registry = new Registry<TestItem>();
         registry.register({ id: 'c', priority: 2, value: 3 });
         registry.register({ id: 'a', priority: 0, value: 1 });
         registry.register({ id: 'b', priority: 1, value: 2 });

         const handedOut = registry.all();
         expect(handedOut.map(item => item.id)).toEqual(['a', 'b', 'c']);

         registry.register({ id: 'd', priority: 3, value: 4 });
         expect(handedOut.map(item => item.id)).toEqual(['a', 'b', 'c']);
      });

      it('invalidates the cache when an item is registered', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         const before = registry.all();
         registry.register({ id: 'b', value: 2 });
         const after = registry.all();

         expect(after).not.toBe(before);
         expect(after.map(item => item.id)).toEqual(['a', 'b']);
      });

      it('invalidates the cache when an item is unregistered', () => {
         const registry = new Registry<TestItem>();
         registry.register({ id: 'a', value: 1 });
         registry.register({ id: 'b', value: 2 });
         const before = registry.all();
         registry.unregister('a');
         const after = registry.all();

         expect(after).not.toBe(before);
         expect(after.map(item => item.id)).toEqual(['b']);
      });
   });
});
