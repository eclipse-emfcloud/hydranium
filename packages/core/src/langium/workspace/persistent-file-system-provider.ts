/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { URI } from '@hydranium/langium';
import { type WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { serverSharedFactory, type ServerSharedServicesMinimal } from '../shared-services.js';
import { type FileSystemSeed, InMemoryFileSystemProvider, type InMemoryFileSystemOptions } from './in-memory-file-system-provider.js';

/**
 * An asynchronous key/value store a {@link PersistentFileSystemProvider} mirrors
 * its writes into and is restored from.
 *
 * # Why a store behind the map, rather than a provider over the store
 *
 * Langium's `FileSystemProvider` requires SYNCHRONOUS reads — `statSync`,
 * `existsSync`, `readFileSync`, `readDirectorySync` — and the stores a browser
 * offers cannot answer synchronously: `IndexedDB` has no sync API at all, and
 * OPFS has synchronous file handles but still enumerates a directory
 * asynchronously, so even there a directory index has to be held in memory. A
 * store therefore cannot back the provider directly, whatever it is. The map
 * stays the read path and the store is a write-through mirror loaded once,
 * before the server starts.
 *
 * # A key here is a SEED key, not a URI
 *
 * Keys are exactly {@link FileSystemSeed} keys: relative to the provider's
 * `rootUri` when it has one, an absolute URI string when it does not. Two
 * consequences worth having — a stored workspace reloads under a different
 * `rootUri` than it was written from, and the seed and the store are the same
 * key space, so restoring is an overlay rather than a translation step only one
 * side would remember.
 *
 * # Failure is the caller's to see
 *
 * Every method may reject, and the provider propagates a rejection out of
 * `writeFile` rather than absorbing it — a save that reports success for content
 * no store holds is the failure this seam exists to make impossible. Browser
 * storage really does fail: a quota is finite, and the user agent may EVICT the
 * whole origin's storage under pressure or on a "clear site data".
 */
export interface FileSystemStore {
   /**
    * Everything the store holds. An empty record is the first-visit answer and
    * not an error, which is what makes the provider's seed the baseline.
    */
   load(): Promise<FileSystemSeed>;
   /**
    * Store `content` under `path`, replacing any previous content.
    *
    * `content` is OPAQUE and must be stored byte for byte: the provider also
    * writes a deletion marker through here, so a store that validated or
    * normalised what it was given would turn a delete into a file whose content
    * is the marker.
    */
   write(path: string, content: string): Promise<void>;
   /** Drop `path`. Storing nothing there already is not an error. */
   remove(path: string): Promise<void>;
}

/**
 * The stored VALUE that means "deleted", as opposed to content.
 *
 * NUL-wrapped so no document can be taken for one: a file whose entire content
 * is this exact string would be restored as a deletion, and text a grammar can
 * parse holds no NUL. Deliberately not exported — a store must treat it as
 * opaque content, and a host that could recognise it would be tempted to.
 */
const TOMBSTONE = '\u0000hydranium:deleted\u0000';

/** Options for {@link PersistentFileSystemProvider} and {@link persistentFileSystem}. */
export interface PersistentFileSystemOptions extends InMemoryFileSystemOptions {
   /** The store writes mirror into and {@link restored} content came out of. */
   store: FileSystemStore;
   /**
    * Content already read out of {@link store}, applied OVER
    * {@link InMemoryFileSystemOptions.seed} at construction.
    *
    * Filled by {@link persistentFileSystem}, which is the supported way in: the
    * provider is constructed synchronously by the services factory, so a load
    * cannot happen inside it.
    */
   restored?: FileSystemSeed;
}

/**
 * An {@link InMemoryFileSystemProvider} whose writes survive the page: the map
 * is still the read path, and every write is mirrored into an asynchronous
 * {@link FileSystemStore} that the next start is restored from.
 *
 * # The seed is the baseline and the store is the delta
 *
 * A restored entry wins over the seed for the same key; a seeded file the store
 * has never heard of is served from the seed. So a first visit is the seed
 * exactly, a returning visit is the seed with the edits laid over it, and a file
 * the host adds to its seed later appears for a visitor who already has stored
 * content — which whole-store precedence would have hidden until they cleared
 * their storage.
 *
 * # Deleting a seeded file writes a marker, because dropping its entry would not
 *
 * A delta over a baseline cannot express absence by omission: removing the
 * stored entry for a seeded file returns it to its seeded content on the next
 * restore, which is a deletion that undoes itself. So {@link deleteFile} stores
 * a TOMBSTONE for a path the seed carries, and restoring one applies it as a
 * deletion rather than as content. Re-creating the file is an ordinary write over
 * the marker, so nothing has to un-mark it.
 *
 * A path the seed does NOT carry needs no marker — absence from the store is
 * already absence — so its entry is removed instead, which is what keeps a host
 * that creates and deletes scratch files from growing the store forever.
 *
 * The marker is a reserved VALUE rather than a reserved key, and that is for the
 * store's sake: a key is a seed-space path by contract, and a store may map keys
 * to real filenames, where a reserved key prefix would ask it to create a file
 * whose name is not a path. As a value it needs nothing from any store. Two
 * consequences worth knowing: a host that reads the store directly — to count
 * what is held, say — sees marker entries among the content ones and cannot tell
 * them apart; and a document whose ENTIRE content is the marker string would be
 * restored as deleted, which is why the marker is NUL-wrapped and text a grammar
 * can parse is not.
 *
 * # A registered virtual document still wins
 *
 * `readFileSync` consults the virtual-document seam before the map, so a stdlib
 * contributed in code keeps answering for its URI whether or not the store holds
 * one. The store cannot shadow it, which is what keeps a rebuild that re-reads
 * that URI from losing the stdlib.
 *
 * # What it deliberately does not answer
 *
 * The store is scoped to the ORIGIN, not to the page: two pages on the same
 * origin share it, and the user agent may evict it entirely. Both are properties
 * of browser storage rather than of this class, and neither is worth a stub —
 * eviction presents as a first visit, which is a state this provider is
 * correct in.
 */
export class PersistentFileSystemProvider extends InMemoryFileSystemProvider {
   protected readonly store: FileSystemStore;
   /**
    * The map-key prefix store keys are relative to, WITH its trailing
    * separator, or `undefined` when store keys are absolute URIs.
    */
   protected readonly storeRoot?: string;
   /**
    * The seed's paths, in STORE-key space rather than as the record was written.
    *
    * Normalised on the way in for the same reason restoring is: a seed key and
    * the key derived from a URI disagree for a percent-encodable path, so a raw
    * `Object.keys` set would call `a b.x` unseeded and remove its entry instead
    * of marking it — a deletion that quietly undoes itself on the next load.
    */
   protected readonly seededPaths: ReadonlySet<string>;

   constructor(services: ServerSharedServicesMinimal, options: PersistentFileSystemOptions) {
      super(services, options);
      this.store = options.store;
      this.storeRoot = options.rootUri === undefined ? undefined : `${this.fileKey(options.rootUri)}/`;
      this.seededPaths = new Set(Object.keys(options.seed ?? {}).map(path => this.storeKey(this.storeUri(path))));
      for (const [path, content] of Object.entries(options.restored ?? {})) {
         // `super.*`, so restoring does not mirror straight back into the store
         // it just came from — a write-back on every start, and one that would
         // resurrect an entry the store had legitimately dropped.
         //
         // Applied AFTER the seed and through the same key normalisation, which
         // is what makes "restored wins" hold for a key the two spell
         // differently (`a b.x` against `a%20b.x`) instead of depending on the
         // insertion order of a merged record.
         const uri = this.storeUri(path);
         if (content === TOMBSTONE) {
            super.deleteFile(uri);
         } else {
            super.setFile(uri, content);
         }
      }
   }

   /**
    * The sync twin, mirrored without waiting.
    *
    * It has no way to report a store failure to its caller, so the tracer is the
    * only channel it has — which is why {@link writeFile}, the path a save
    * actually takes, awaits instead.
    */
   override setFile(uri: URI, content: string): void {
      super.setFile(uri, content);
      this.persist(uri, content).catch((error: unknown) => this.reportStoreFailure('store', uri, error));
   }

   /**
    * Write through to the store and REJECT if it refuses.
    *
    * A quota failure or an evicted origin has to reach the client that asked for
    * the save: the alternative is a page that reports a saved workspace and
    * reloads without it, which is the same shape as persistence working.
    *
    * `super.setFile` rather than `this.setFile`, so the awaited mirror below is
    * the only one — the override would fire a second, unawaited write for the
    * same content.
    */
   override async writeFile(uri: URI, content: string): Promise<void> {
      super.setFile(uri, content);
      await this.persist(uri, content);
   }

   override deleteFile(uri: URI): void {
      super.deleteFile(uri);
      this.forget(uri).catch((error: unknown) => this.reportStoreFailure('forget', uri, error));
   }

   /** The absolute URI a store-space `path` addresses. */
   protected storeUri(path: string): URI {
      return URI.parse(this.storeRoot === undefined ? path : `${this.storeRoot}${path}`);
   }

   /** Mirror one write. `async` so a bad key rejects rather than throwing at the call site. */
   protected async persist(uri: URI, content: string): Promise<void> {
      await this.store.write(this.storeKey(uri), content);
   }

   /**
    * Mirror one deletion: a tombstone where the seed would otherwise bring the
    * file back, a plain removal where it would not. `async` for the same reason
    * as {@link persist}.
    */
   protected async forget(uri: URI): Promise<void> {
      const path = this.storeKey(uri);
      if (this.seededPaths.has(path)) {
         await this.store.write(path, TOMBSTONE);
      } else {
         await this.store.remove(path);
      }
   }

   /**
    * The store key for `uri`, in the seed's key space.
    *
    * Throws for a URI outside `rootUri` rather than keying it absolutely beside
    * the relative ones: a store holding both spellings restores under neither,
    * and a host writing outside the workspace it declared has a wiring fault
    * worth hearing about.
    */
   protected storeKey(uri: URI): string {
      const key = this.fileKey(uri);
      if (this.storeRoot === undefined) {
         return key;
      }
      if (!key.startsWith(this.storeRoot)) {
         throw new Error(`Cannot persist ${uri.toString()}: outside the store root ${this.storeRoot}`);
      }
      return key.slice(this.storeRoot.length);
   }

   protected reportStoreFailure(operation: string, uri: URI, error: unknown): void {
      this.tracer.error(`Failed to ${operation} ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
   }
}

/**
 * Restore `options.store` and bind a {@link PersistentFileSystemProvider} over
 * it, spread into the services context exactly where a Node host spreads
 * `NodeFileSystem`.
 *
 * **It is asynchronous, and that is the ordering contract rather than an
 * implementation detail.** The provider's reads are synchronous, so the stored
 * workspace must be in the map before anything reads it — and a `hydrate()`
 * method on the provider could not enforce that, because awaiting one after the
 * transport exists is already too late: a `BrowserMessageReader` starts its port
 * on construction but fires into an emitter with no listener until
 * `startLanguageServer` calls `listen`, so an `initialize` arriving during the
 * await is DROPPED — no error, no reply, a client that waits forever. Loading
 * here, before the services and therefore before the connection exist, makes
 * that unrepresentable rather than documented.
 */
export async function persistentFileSystem(options: PersistentFileSystemOptions): Promise<{
   fileSystemProvider: (services: unknown) => WritableFileSystemProvider;
}> {
   const restored = await options.store.load();
   return {
      fileSystemProvider: serverSharedFactory(services => new PersistentFileSystemProvider(services, { ...options, restored }))
   };
}
