/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// A fake IndexedDB on the global, since Node has none. One factory for the
// whole file: isolation is by database NAME, which is also the one thing the
// constructor takes, so every case exercises it.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbFileSystemStore } from '../../src/browser/index.js';

let databases = 0;

/** A store on a database no other case has opened. */
function freshStore(): { store: IndexedDbFileSystemStore; name: string } {
   const name = `workspace-${++databases}`;
   return { store: new IndexedDbFileSystemStore(name), name };
}

/** The protected write seam, used to plant a row the current code never writes. */
class RawStore extends IndexedDbFileSystemStore {
   putRaw(path: string, value: unknown): Promise<void> {
      return this.mutate('store', files => files.put(value, path));
   }
}

describe('IndexedDbFileSystemStore', () => {
   it('loads nothing on a first visit', async () => {
      const { store } = freshStore();
      await expect(store.load()).resolves.toEqual({});
   });

   it('loads what was written, keyed by path, from a second instance on the same name', async () => {
      const { store, name } = freshStore();
      await store.write('a/one.x', 'one');
      await store.write('b/two.x', 'two');
      await expect(new IndexedDbFileSystemStore(name).load()).resolves.toEqual({ 'a/one.x': 'one', 'b/two.x': 'two' });
   });

   it('replaces the content under a path on a second write', async () => {
      const { store } = freshStore();
      await store.write('a/one.x', 'one');
      await store.write('a/one.x', 'one again');
      await expect(store.load()).resolves.toEqual({ 'a/one.x': 'one again' });
   });

   it('keeps content byte for byte, a NUL-wrapped marker included', async () => {
      const { store } = freshStore();
      await store.write('a/one.x', '\u0000marker\u0000');
      await expect(store.load()).resolves.toEqual({ 'a/one.x': '\u0000marker\u0000' });
   });

   it('drops a removed path and tolerates removing one it never held', async () => {
      const { store } = freshStore();
      await store.write('a/one.x', 'one');
      await store.remove('a/one.x');
      await store.remove('never/held.x');
      await expect(store.load()).resolves.toEqual({});
   });

   it('clears everything, so the next load is a first visit', async () => {
      const { store, name } = freshStore();
      await store.write('a/one.x', 'one');
      await store.write('b/two.x', 'two');
      await store.clear();
      await expect(new IndexedDbFileSystemStore(name).load()).resolves.toEqual({});
   });

   it('keeps two database names apart', async () => {
      const first = freshStore();
      const second = freshStore();
      await first.store.write('a/one.x', 'one');
      await expect(second.store.load()).resolves.toEqual({});
   });

   it('closes its connection when a later version opens, so the upgrade is not blocked', async () => {
      // A tab left open on this version would otherwise hold the upgrade of a
      // newer tab forever; from then on this store's own calls reject, loudly.
      const { store, name } = freshStore();
      await store.write('a/one.x', 'one');
      const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
         const request = indexedDB.open(name, 2);
         request.onsuccess = () => resolve(request.result);
         request.onerror = () => reject(request.error);
         request.onblocked = () => reject(new Error('blocked by the store'));
      });
      upgraded.close();
      await expect(store.write('a/one.x', 'two')).rejects.toThrow();
   });

   it('retries the open after a failed one rather than caching the failure', async () => {
      const { store } = freshStore();
      const real = indexedDB;
      // One open that fails, then the real factory again.
      globalThis.indexedDB = {
         open: () => {
            const request = { error: new Error('refused'), onerror: undefined as (() => void) | undefined };
            setTimeout(() => request.onerror?.(), 0);
            return request as unknown as IDBOpenDBRequest;
         }
      } as unknown as IDBFactory;
      try {
         await expect(store.load()).rejects.toThrow('refused');
      } finally {
         globalThis.indexedDB = real;
      }
      await expect(store.load()).resolves.toEqual({});
   });

   it('closes a connection that opens after it reported the open as blocked', async () => {
      const { store } = freshStore();
      const real = indexedDB;
      const closed: string[] = [];
      globalThis.indexedDB = {
         open: () => {
            const request = {
               result: { close: () => closed.push('closed') },
               onblocked: undefined as (() => void) | undefined,
               onsuccess: undefined as (() => void) | undefined
            };
            setTimeout(() => {
               request.onblocked?.();
               request.onsuccess?.();
            }, 0);
            return request as unknown as IDBOpenDBRequest;
         }
      } as unknown as IDBFactory;
      try {
         await expect(store.load()).rejects.toThrow('open in another tab');
         await new Promise(resolve => setTimeout(resolve, 0));
      } finally {
         globalThis.indexedDB = real;
      }
      expect(closed).toEqual(['closed']);
   });

   it('skips a row whose value is not a string rather than restoring it as content', async () => {
      // The database outlives the code that wrote it, so a row from an older
      // shape must not reach the filesystem as non-string content.
      const name = `workspace-${++databases}`;
      const raw = new RawStore(name);
      await raw.putRaw('legacy.x', { content: 'one' });
      await raw.write('a/one.x', 'one');
      await expect(new IndexedDbFileSystemStore(name).load()).resolves.toEqual({ 'a/one.x': 'one' });
   });
});
