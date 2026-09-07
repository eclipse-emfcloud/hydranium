/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Disposable } from 'vscode-languageserver';

/**
 * Common shape for items stored in a {@link Registry}: a stable identity, an
 * optional label for log lines, and an optional sort key.
 */
export interface RegistryItem {
   /** Stable machine identifier; required, and must be unique within the registry. */
   readonly id: string;
   /** Human-readable name for logs; consumers fall back to {@link RegistryItem.id} when it is absent. */
   readonly label?: string;
   /**
    * Sort key for {@link Registry.all}: lower runs first, ties break by
    * registration order. Defaults to `0`, so items that set no priority keep
    * their registration order among themselves.
    */
   readonly priority?: number;
}

/**
 * A small, generic, id-keyed registry with priority-ordered iteration, used
 * wherever a framework service needs multi-binding-style registration.
 *
 * Identity lives on the item itself ({@link RegistryItem.id}) rather than on a
 * registration handle, so an adopter can remove a built-in registration by id
 * without holding the {@link Disposable} the framework's own `register` call
 * returned.
 */
export class Registry<T extends RegistryItem> {
   protected readonly items: T[] = [];
   /** Sorted snapshot backing {@link all}; discarded on every mutation. */
   protected cachedSorted: readonly T[] | undefined;

   /**
    * Add an item. Throws if an item with the same {@link RegistryItem.id} is
    * already registered — duplicate ids are a programming error, not a
    * silent overwrite.
    *
    * @returns a {@link Disposable} that removes THIS item when disposed, and
    * nothing else. Keyed by identity rather than by {@link RegistryItem.id}:
    * an id-keyed handle removes whatever item holds that id at the moment it
    * is disposed, so a stale handle disposed after the id was unregistered and
    * re-registered silently unregisters a DIFFERENT item it never owned.
    * Identity also makes a repeat dispose inert without a separate flag.
    */
   register(item: T): Disposable {
      if (this.items.some(existing => existing.id === item.id)) {
         throw new Error(`Duplicate registry id: '${item.id}'`);
      }
      this.items.push(item);
      this.cachedSorted = undefined;
      return Disposable.create(() => {
         const index = this.items.indexOf(item);
         if (index < 0) {
            return;
         }
         this.items.splice(index, 1);
         this.cachedSorted = undefined;
      });
   }

   /** Remove an item by id. Returns `true` if an item was removed, `false` otherwise. */
   unregister(id: string): boolean {
      const index = this.items.findIndex(item => item.id === id);
      if (index < 0) {
         return false;
      }
      this.items.splice(index, 1);
      this.cachedSorted = undefined;
      return true;
   }

   /** Whether an item with the given id is registered. */
   has(id: string): boolean {
      return this.items.some(item => item.id === id);
   }

   /** Get an item by id, or `undefined` if not registered. */
   get(id: string): T | undefined {
      return this.items.find(item => item.id === id);
   }

   /** Number of registered items. */
   get size(): number {
      return this.items.length;
   }

   /**
    * All registered items in iteration order: {@link RegistryItem.priority}
    * ascending, ties broken by registration order. Priority orders the whole
    * registry; a consumer that partitions the result further owns whatever
    * ordering holds across its own partitions.
    *
    * **The identity of the returned array is part of the contract.** This is
    * the hot read path while registration is rare, so the sorted list is built
    * once and discarded only by a register / unregister: repeated calls with no
    * intervening mutation return the *same* array reference and allocate
    * nothing. Consumers rely on that reference as a cache key — deriving a
    * secondary index from `all()` and rebuilding it only when the reference
    * changes is the intended pattern, so returning a freshly built array per
    * call would leave every such index rebuilding on every read. The guarantee
    * is pinned by a test of its own.
    *
    * Treat the result as read-only: mutating it corrupts the cache for every
    * other caller, which the `readonly` element type exists to prevent.
    *
    * Registration order for ties comes from the SORT's stability, required of
    * `Array.prototype.sort` since ES2019, not from a secondary comparator key.
    * A key would have to carry the index alongside each item, costing a wrapper
    * object per item per rebuild, and could not change the result for any input
    * — a comparator result of `NaN` or `-0` is normatively coerced to `+0`, so
    * the primary comparison never leaves a tie for it to break differently.
    */
   all(): readonly T[] {
      if (this.cachedSorted === undefined) {
         this.cachedSorted = [...this.items].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
      }
      return this.cachedSorted;
   }
}
