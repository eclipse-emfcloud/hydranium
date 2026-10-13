/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FileSystemSeed } from '../langium/workspace/in-memory-file-system-provider.js';
import type { FileSystemStore } from '../langium/workspace/persistent-file-system-provider.js';

/** Out-of-line keys, so a key is the store path and the value is the content. */
const OBJECT_STORE_NAME = 'files';

/**
 * The schema version. A bump needs a migration in `onupgradeneeded`, or every
 * returning visitor's rows are left in a store the new code never reads.
 */
const DATABASE_VERSION = 1;

/**
 * A {@link FileSystemStore} in `IndexedDB`, so an edit survives a reload.
 *
 * # Why IndexedDB and not OPFS
 *
 * OPFS is the tempting answer, because `createSyncAccessHandle` gives
 * SYNCHRONOUS file reads in a worker, which is what Langium's
 * `FileSystemProvider` needs. It buys nothing here: directory enumeration
 * (`FileSystemDirectoryHandle.entries()`) is async-only, so a directory index
 * still has to live in memory, and once it does the file reads are being served
 * from memory too. IndexedDB is the smaller dependency for the same shape.
 *
 * # It holds the DELTA, not the workspace
 *
 * Only what has been written lands here, and `PersistentFileSystemProvider` lays
 * it over the host's seed. So a fixture edited in the host's bundle still
 * reaches a returning visitor, and this database stays a few kilobytes rather
 * than a copy of the workspace.
 *
 * # A failure is loud, deliberately
 *
 * Nothing here degrades to non-persistent operation. A refused open, a blocked
 * upgrade or an aborted transaction, which is what a quota overrun looks like,
 * rejects the call, which fails the worker's bootstrap or the save that asked.
 * The alternative, carrying on without a store, would report a saved workspace
 * and lose it on the next load. An origin EVICTED between visits is not a
 * failure this class can see: its database opens empty, which is a first visit,
 * and the provider is correct in that state. Evicted mid-session, the next
 * transaction rejects like any other failure.
 *
 * # The database is origin-scoped
 *
 * Every page on the origin shares a database of the same name, and the user
 * agent may evict it. The name is the one per-app value and is REQUIRED for
 * that reason: a default would let two apps on one origin overwrite each
 * other's edits with nothing reporting it.
 */
export class IndexedDbFileSystemStore implements FileSystemStore {
   /**
    * Opened once and shared, and NOT kept when it fails: a refused or blocked
    * open rejects the call that needed it and the next call opens again, so a
    * cause that has cleared, such as the other tab closing, does not fail every
    * later save with the first error.
    */
   protected connection?: Promise<IDBDatabase>;

   constructor(protected readonly databaseName: string) {}

   async load(): Promise<FileSystemSeed> {
      const database = await this.open();
      return new Promise<FileSystemSeed>((resolve, reject) => {
         const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
         const files = transaction.objectStore(OBJECT_STORE_NAME);
         const keyRequest = files.getAllKeys();
         const valueRequest = files.getAll();
         // Resolved on the TRANSACTION rather than on either request, which is
         // what guarantees both have landed, and `getAllKeys` and `getAll`
         // enumerate in the same key order, so they zip.
         transaction.oncomplete = () => {
            const keys: IDBValidKey[] = keyRequest.result;
            const values: unknown[] = valueRequest.result;
            const seed: Record<string, string> = {};
            keys.forEach((key, index) => {
               const value = values[index];
               // Guarded rather than cast: this database outlives the code that
               // wrote it, so a row from an older shape must be skipped instead
               // of reaching the filesystem as non-string content.
               if (typeof key === 'string' && typeof value === 'string') {
                  seed[key] = value;
               }
            });
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
    * The escape hatch a persistent host needs and a seeded one does not: a saved
    * document that no longer parses is otherwise restored on every load, and
    * clearing site data is the only other way out. Not on {@link FileSystemStore},
    * which the provider never clears.
    */
   async clear(): Promise<void> {
      await this.mutate('clear', files => files.clear());
   }

   /**
    * Run one write transaction and settle on its COMPLETION.
    *
    * Not on the request's `success`: a request can succeed inside a transaction
    * that then aborts, which is exactly what a quota overrun looks like, so
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
      this.connection ??= this.openDatabase().catch((error: unknown) => {
         this.connection = undefined;
         throw error;
      });
      return this.connection;
   }

   protected openDatabase(): Promise<IDBDatabase> {
      return new Promise<IDBDatabase>((resolve, reject) => {
         const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
         let blocked = false;
         request.onupgradeneeded = () => {
            // Runs on a first visit and on a version bump. `createObjectStore`
            // throws if it already exists, so the guard is not defensive: a page
            // opened twice with the store created once gets here only when the
            // version moved.
            if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
               request.result.createObjectStore(OBJECT_STORE_NAME);
            }
         };
         request.onsuccess = () => {
            const database = request.result;
            if (blocked) {
               // Went through once the other tab closed, after this call had
               // rejected. Nobody holds it, so it is closed rather than left
               // open to block the NEXT upgrade.
               database.close();
               return;
            }
            // A newer version opening in another tab asks this one to let go,
            // and holding on would block that upgrade for as long as this tab
            // lives. Dropped, so every later call here rejects, which is loud.
            database.onversionchange = () => {
               database.close();
               this.connection = undefined;
            };
            resolve(database);
         };
         request.onerror = () => reject(request.error ?? new Error(`Cannot open ${this.databaseName}`));
         // A tab at an older version that lacks the close above holds the
         // upgrade indefinitely. Reported rather than waited on: the host can say
         // so, where a hung open looks like a worker that never started.
         request.onblocked = () => {
            blocked = true;
            reject(new Error(`${this.databaseName} is open in another tab at an older version`));
         };
      });
   }

   protected failure(transaction: IDBTransaction, operation: string): Error {
      // `transaction.error` names the real cause (`QuotaExceededError` above
      // all); an abort with no error is a caller-side abort, which nothing here
      // does.
      return transaction.error ?? new Error(`Failed to ${operation} in ${this.databaseName}`);
   }
}
