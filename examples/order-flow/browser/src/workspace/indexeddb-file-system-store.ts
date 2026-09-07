/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `IndexedDB` behind the worker's filesystem, so an edit survives a reload.
 *
 * # Why IndexedDB and not OPFS
 *
 * OPFS is the tempting answer, because `createSyncAccessHandle` gives
 * SYNCHRONOUS file reads in a worker — which is what Langium's
 * `FileSystemProvider` needs. It buys nothing here: directory enumeration
 * (`FileSystemDirectoryHandle.entries()`) is async-only, so a directory index
 * still has to live in memory, and once it does the file reads are being served
 * from memory too. IndexedDB is the smaller dependency for the same shape.
 *
 * # It holds the DELTA, not the workspace
 *
 * Only what has been written lands here, and
 * `@hydranium/core`'s `PersistentFileSystemProvider` lays it over the generated
 * seed. So a fixture edited in the repository still reaches a returning visitor,
 * and this database stays a few kilobytes rather than a copy of the workspace.
 *
 * # A failure is loud, deliberately
 *
 * Nothing here degrades to non-persistent operation. A blocked or evicted store
 * makes `load` reject, which fails the worker's bootstrap and shows up in the
 * page's own error line — where the alternative, carrying on without a store,
 * would report a saved workspace and lose it on the next load.
 */

import type { FileSystemSeed, FileSystemStore } from '@hydranium/core';

/**
 * Origin-scoped, like all browser storage: every page on this origin shares this
 * database, and the user agent may evict it. Named for the example rather than
 * generically, so a second app on the same origin does not collide.
 */
const DATABASE_NAME = 'order-flow-browser-workspace';

/** Out-of-line keys, so a key is the store path and the value is the content. */
const OBJECT_STORE_NAME = 'files';

const DATABASE_VERSION = 1;

export class IndexedDbFileSystemStore implements FileSystemStore {
   /** Opened once and shared: a second `open` for the same version is a second connection to hold. */
   protected connection?: Promise<IDBDatabase>;

   /**
    * The keys the last {@link load} returned.
    *
    * Kept so the page can report "restored N file(s)" without a second read of
    * the whole store — and so the report distinguishes a first visit from a
    * restore, which the workspace content alone cannot.
    */
   restoredPaths: readonly string[] = [];

   async load(): Promise<FileSystemSeed> {
      const database = await this.open();
      return new Promise<FileSystemSeed>((resolve, reject) => {
         const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
         const files = transaction.objectStore(OBJECT_STORE_NAME);
         const keyRequest = files.getAllKeys();
         const valueRequest = files.getAll();
         // Resolved on the TRANSACTION rather than on either request, which is
         // what guarantees both have landed — and `getAllKeys` and `getAll`
         // enumerate in the same key order, so they zip.
         transaction.oncomplete = () => {
            const keys: IDBValidKey[] = keyRequest.result;
            const values: unknown[] = valueRequest.result;
            const seed: Record<string, string> = {};
            keys.forEach((key, index) => {
               const value = values[index];
               // Guarded rather than cast: this database outlives the code that
               // wrote it, so a row from an older shape must be skipped instead
               // of reaching the filesystem as `undefined` content.
               if (typeof key === 'string' && typeof value === 'string') {
                  seed[key] = value;
               }
            });
            this.restoredPaths = Object.keys(seed);
            resolve(seed);
         };
         transaction.onabort = () => reject(this.failure(transaction, 'read the stored workspace'));
      });
   }

   async write(path: string, content: string): Promise<void> {
      await this.mutate('store', files => files.put(content, path));
   }

   async remove(path: string): Promise<void> {
      await this.mutate('drop', files => files.delete(path));
   }

   /**
    * Drop everything, returning the next load to the seed.
    *
    * The escape hatch a persistent page needs and a seeded one does not: a saved
    * document that no longer parses is otherwise restored on every load, and
    * clearing site data is the only way out.
    */
   async clear(): Promise<void> {
      await this.mutate('clear', files => files.clear());
   }

   /**
    * Run one write transaction and settle on its COMPLETION.
    *
    * Not on the request's `success`: a request can succeed inside a transaction
    * that then aborts — which is exactly what a quota overrun looks like — so
    * resolving early would report a save the database never kept.
    */
   protected async mutate(operation: string, act: (files: IDBObjectStore) => void): Promise<void> {
      const database = await this.open();
      return new Promise<void>((resolve, reject) => {
         const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
         transaction.oncomplete = () => resolve();
         transaction.onabort = () => reject(this.failure(transaction, operation));
         act(transaction.objectStore(OBJECT_STORE_NAME));
      });
   }

   protected open(): Promise<IDBDatabase> {
      this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
         const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
         request.onupgradeneeded = () => {
            // Runs on a first visit and on a version bump. `createObjectStore`
            // throws if it already exists, so the guard is not defensive: a page
            // opened twice with the store created once gets here only when the
            // version moved.
            if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
               request.result.createObjectStore(OBJECT_STORE_NAME);
            }
         };
         request.onsuccess = () => resolve(request.result);
         request.onerror = () => reject(request.error ?? new Error(`Cannot open ${DATABASE_NAME}`));
         // A connection held by another tab at an older version blocks the
         // upgrade indefinitely. Reported rather than waited on: the page can say
         // so, where a hung open looks like a worker that never started.
         request.onblocked = () => reject(new Error(`${DATABASE_NAME} is open in another tab at an older version`));
      });
      return this.connection;
   }

   protected failure(transaction: IDBTransaction, operation: string): Error {
      // `transaction.error` names the real cause (`QuotaExceededError` above
      // all); an abort with no error is a caller-side abort, which nothing here
      // does.
      return transaction.error ?? new Error(`Failed to ${operation} in ${DATABASE_NAME}`);
   }
}
