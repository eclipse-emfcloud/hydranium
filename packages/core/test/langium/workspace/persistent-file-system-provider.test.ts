/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { type FileSystemSeed } from '../../../src/langium/workspace/in-memory-file-system-provider.js';
import {
   type FileSystemStore,
   PersistentFileSystemProvider,
   persistentFileSystem
} from '../../../src/langium/workspace/persistent-file-system-provider.js';
import { virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

const ROOT = 'file:///workspace';

/** The seeded baseline every case below overlays a store on. */
const SEED: FileSystemSeed = {
   'alpha/one.a': 'seeded one',
   'beta/two.b': 'seeded two'
};

/**
 * A {@link FileSystemStore} in a `Map`, recording what it was asked to do.
 *
 * Records rather than asserting on a spy, because the interesting properties are
 * about what was NOT written: a restore that mirrored itself back would be
 * invisible in the store's contents and obvious in `writes`.
 */
class RecordingStore implements FileSystemStore {
   readonly contents = new Map<string, string>();
   readonly writes: string[] = [];
   readonly removals: string[] = [];
   /** Set to reject every mutation, standing in for a quota failure. */
   failure?: Error;

   constructor(initial: FileSystemSeed = {}) {
      for (const [path, content] of Object.entries(initial)) {
         this.contents.set(path, content);
      }
   }

   async load(): Promise<FileSystemSeed> {
      return Object.fromEntries(this.contents);
   }

   async write(path: string, content: string): Promise<void> {
      // Suspends before recording, like every real store: an `async` method that
      // never awaits records SYNCHRONOUSLY, which would make the fire-and-forget
      // mirror below indistinguishable from an awaited one.
      await Promise.resolve();
      if (this.failure) {
         throw this.failure;
      }
      this.writes.push(path);
      this.contents.set(path, content);
   }

   async remove(path: string): Promise<void> {
      await Promise.resolve();
      if (this.failure) {
         throw this.failure;
      }
      this.removals.push(path);
      this.contents.delete(path);
   }
}

/** Let every queued mirror settle. A macrotask, so it drains the microtasks too. */
async function flush(): Promise<void> {
   await new Promise(resolve => setTimeout(resolve, 0));
}

function servicesWith(virtualDocuments: Record<string, string> = {}): ServerSharedServicesMinimal {
   return makeNoopSharedServices({
      workspace: {
         LangiumDocuments: {
            getDocument(uri: URI): LangiumDocument | undefined {
               const text = virtualDocuments[uri.toString()];
               return text === undefined ? undefined : ({ uri, textDocument: { getText: () => text } } as unknown as LangiumDocument);
            }
         }
      }
   });
}

/**
 * The provider a host would get from {@link persistentFileSystem}, built the same
 * way — through the factory, so the load-then-construct order under test is the
 * one every case exercises.
 */
async function restored(
   store: FileSystemStore,
   options: { seed?: FileSystemSeed; rootUri?: string; virtualDocuments?: Record<string, string> } = {}
): Promise<PersistentFileSystemProvider> {
   const { fileSystemProvider } = await persistentFileSystem({
      store,
      seed: options.seed ?? SEED,
      rootUri: 'rootUri' in options ? options.rootUri : ROOT
   });
   const provider = fileSystemProvider(servicesWith(options.virtualDocuments));
   if (!(provider instanceof PersistentFileSystemProvider)) {
      throw new Error('persistentFileSystem bound something else');
   }
   return provider;
}

describe('PersistentFileSystemProvider restore', () => {
   it('serves a stored file in place of the seeded one', async () => {
      const files = await restored(new RecordingStore({ 'alpha/one.a': 'edited one' }));
      expect(files.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('edited one');
   });

   it('still serves a seeded file the store has never held', async () => {
      // The seed is the BASELINE, not a first-visit fallback that whole-store
      // precedence would discard: a file added to the seed after a visitor
      // stored something must still appear for them.
      const files = await restored(new RecordingStore({ 'alpha/one.a': 'edited one' }));
      expect(files.readFileSync(URI.parse(`${ROOT}/beta/two.b`))).toBe('seeded two');
   });

   it('serves a stored file that is in no seed at all', async () => {
      const files = await restored(new RecordingStore({ 'gamma/three.c': 'created three' }));
      expect(files.readFileSync(URI.parse(`${ROOT}/gamma/three.c`))).toBe('created three');
      // And the walk can find it, which is the half a bare read cannot show:
      // directories are implied by the keys under them, so a restored entry that
      // bypassed the map's key normalisation would read fine and be invisible to
      // `readDirectory`.
      expect(files.existsSync(URI.parse(`${ROOT}/gamma`))).toBe(true);
   });

   it('is the plain seed when the store is empty, so a first visit is unchanged', async () => {
      const files = await restored(new RecordingStore());
      expect(files.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('seeded one');
   });

   it('does not write the restored content back into the store it came from', async () => {
      // A write-back on every start is not merely wasteful: it would resurrect
      // an entry the store had legitimately dropped, and it would spend the
      // origin's quota on content the seed already carries.
      const store = new RecordingStore({ 'alpha/one.a': 'edited one' });
      await restored(store);
      expect(store.writes).toEqual([]);
   });

   it('takes store keys as absolute URIs when there is no rootUri', async () => {
      const files = await restored(new RecordingStore({ 'test:///a.a': 'stored absolute' }), {
         seed: { 'test:///a.a': 'seeded absolute' },
         rootUri: undefined
      });
      expect(files.readFileSync(URI.parse('test:///a.a'))).toBe('stored absolute');
   });

   it('lets a restored entry win over a seed key that spells the same path differently', async () => {
      // `a b.a` and `a%20b.a` are one file and two record keys. Restoring through
      // the map's own normalisation is what decides this; merging the two records
      // first would leave it to their insertion order.
      const files = await restored(new RecordingStore({ 'a%20b.a': 'stored' }), { seed: { 'a b.a': 'seeded' } });
      expect(files.readFileSync(URI.parse(`${ROOT}/a b.a`))).toBe('stored');
   });

   it('serves a registered virtual document rather than the stored content for its URI', async () => {
      // The stdlib is contributed in code and has no file behind it. If the store
      // could shadow it, the first rebuild that re-read that URI would replace
      // the stdlib with whatever a save had once persisted there.
      const uri = virtualUri('builtin', 'types.a');
      const files = await restored(new RecordingStore({ [uri.toString()]: 'stale stdlib' }), {
         seed: {},
         rootUri: undefined,
         virtualDocuments: { [uri.toString()]: 'element Any' }
      });
      expect(files.readFileSync(uri)).toBe('element Any');
   });
});

describe('PersistentFileSystemProvider writes', () => {
   it('mirrors writeFile into the store under a root-relative key', async () => {
      const store = new RecordingStore();
      const files = await restored(store);
      await files.writeFile(URI.parse(`${ROOT}/alpha/one.a`), 'written one');
      // The KEY, not just the content: an absolute key would restore into a
      // second entry beside the seeded one and the edit would never reappear.
      expect(store.writes).toEqual(['alpha/one.a']);
      expect(store.contents.get('alpha/one.a')).toBe('written one');
   });

   it('rejects writeFile when the store refuses, so a save cannot report success', async () => {
      const store = new RecordingStore();
      store.failure = new Error('QuotaExceededError');
      const files = await restored(store);
      await expect(files.writeFile(URI.parse(`${ROOT}/alpha/one.a`), 'written one')).rejects.toThrow('QuotaExceededError');
      // The map took it anyway. The write is what the server now serves and the
      // client was told the save failed, which is the honest pair — a rollback
      // here would discard content no one else holds.
      expect(files.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('written one');
   });

   it('rejects a write outside rootUri rather than storing an unrestorable key', async () => {
      const store = new RecordingStore();
      const files = await restored(store);
      await expect(files.writeFile(URI.parse('file:///elsewhere/four.d'), 'stray')).rejects.toThrow('outside the store root');
      expect(store.writes).toEqual([]);
   });

   it('mirrors the synchronous setFile too, without making the caller wait', async () => {
      const store = new RecordingStore();
      const files = await restored(store);
      files.setFile(URI.parse(`${ROOT}/alpha/one.a`), 'set one');
      // Nothing has reached the store at this point — it catches up on a later
      // turn, which is why this is not the path a save takes.
      expect(store.writes).toEqual([]);
      await flush();
      expect(store.contents.get('alpha/one.a')).toBe('set one');
   });

   // What this asserts is the SWALLOWING, not the mirror — the mirror is the
   // test above. Dropping the mirror's `.catch` does redden the run, but through
   // vitest's unhandled-rejection reporting rather than through an assertion
   // here, so read the failure as a file-level one.
   it('swallows a store failure from setFile rather than throwing at the call site', async () => {
      const store = new RecordingStore();
      store.failure = new Error('QuotaExceededError');
      const files = await restored(store);
      expect(() => files.setFile(URI.parse(`${ROOT}/alpha/one.a`), 'set one')).not.toThrow();
      // Flushed so an unhandled rejection would surface here if the mirror did
      // not catch its own.
      await flush();
      expect(files.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('set one');
   });

   it('marks a deleted SEEDED file rather than dropping its entry', async () => {
      const store = new RecordingStore({ 'alpha/one.a': 'edited one' });
      const files = await restored(store);
      files.deleteFile(URI.parse(`${ROOT}/alpha/one.a`));
      await flush();
      // The KEY survives with a marker in it. Dropping the entry — which is what
      // `remove` would do — is the shape that reads as correct and undoes itself
      // on the next load, because the seed still carries the file.
      expect(store.removals).toEqual([]);
      expect(store.contents.get('alpha/one.a')).toBeDefined();
      expect(store.contents.get('alpha/one.a')).not.toBe('edited one');
   });

   it('keeps a deleted SEEDED file deleted across a restore', async () => {
      const store = new RecordingStore({ 'alpha/one.a': 'edited one' });
      const first = await restored(store);
      first.deleteFile(URI.parse(`${ROOT}/alpha/one.a`));
      await flush();

      const second = await restored(store);
      // Absent, and specifically NOT back at its seeded content: the seed is the
      // baseline, so "the delete was forgotten" and "the delete worked" differ by
      // exactly this.
      expect(second.existsSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe(false);
      expect(() => second.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toThrow('No such file');
   });

   it('never serves a marker as content', async () => {
      // The failure this excludes is not a missing deletion but a present file
      // whose content is the marker string — which parses as garbage rather than
      // reading as absent, so it would surface as a validation error in a
      // document nobody edited.
      const store = new RecordingStore({ 'alpha/one.a': 'edited one' });
      const first = await restored(store);
      first.deleteFile(URI.parse(`${ROOT}/alpha/one.a`));
      await flush();

      const second = await restored(store);
      const contents = second.readDirectorySync(URI.parse(`${ROOT}/alpha`)).map(node => node.uri.toString());
      expect(contents).toEqual([]);
   });

   it('stops reporting the parent directory once a restored marker empties it', async () => {
      // Directories are implied by the keys under them, so a marker applied as
      // anything other than a map deletion would leave the folder present and the
      // workspace walk would descend into it.
      const store = new RecordingStore();
      const first = await restored(store);
      first.deleteFile(URI.parse(`${ROOT}/alpha/one.a`));
      await flush();
      const second = await restored(store);
      expect(second.existsSync(URI.parse(`${ROOT}/alpha`))).toBe(false);
   });

   it('clears the marker when the file is written again', async () => {
      const store = new RecordingStore();
      const first = await restored(store);
      first.deleteFile(URI.parse(`${ROOT}/alpha/one.a`));
      await flush();
      await first.writeFile(URI.parse(`${ROOT}/alpha/one.a`), 'recreated one');

      const second = await restored(store);
      expect(second.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('recreated one');
   });

   it('removes rather than marks a file the seed never carried', async () => {
      // A marker for a path with no seed entry would be a stored row that says
      // nothing — absence from the store already means absent — and a host that
      // creates and deletes scratch files would grow the store forever.
      const store = new RecordingStore({ 'gamma/three.c': 'created three' });
      const files = await restored(store);
      files.deleteFile(URI.parse(`${ROOT}/gamma/three.c`));
      await flush();
      expect(store.removals).toEqual(['gamma/three.c']);
      expect(store.contents.has('gamma/three.c')).toBe(false);
   });

   it('recognises a seeded path spelled with a percent-encodable character', async () => {
      // The seed says `a b.a` and every key derived from a URI says `a%20b.a`, so
      // a seeded-path set built from the raw record keys calls this file unseeded
      // and REMOVES its entry — a deletion that silently undoes itself on the
      // next load, for exactly the paths normalisation exists to handle.
      const store = new RecordingStore();
      const files = await restored(store, { seed: { 'a b.a': 'seeded' } });
      files.deleteFile(URI.parse(`${ROOT}/a b.a`));
      await flush();
      expect(store.removals).toEqual([]);
      expect(store.contents.get('a%20b.a')).toBeDefined();
   });
});

describe('persistentFileSystem', () => {
   it('binds a provider carrying writeFile, which is what the slot requires', async () => {
      // Without `writeFile` the context slot silently swaps in the empty
      // provider, which presents as an empty workspace rather than as a wiring
      // error — and a persistent filesystem that never writes is exactly that
      // failure with an extra store attached.
      const { fileSystemProvider } = await persistentFileSystem({ store: new RecordingStore(), seed: SEED, rootUri: ROOT });
      const bound = fileSystemProvider(servicesWith());
      expect(typeof bound.writeFile).toBe('function');
      expect(bound.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('seeded one');
   });

   it('loads the store before it returns, so nothing can construct services first', async () => {
      // The ordering IS the contract: the provider's reads are synchronous, so a
      // load that resolved after the services existed would let the workspace
      // walk read the seed and a save then persist over the stored workspace.
      let loaded = false;
      const store: FileSystemStore = {
         async load() {
            await Promise.resolve();
            loaded = true;
            return { 'alpha/one.a': 'edited one' };
         },
         async write() {},
         async remove() {}
      };
      const binding = persistentFileSystem({ store, seed: SEED, rootUri: ROOT });
      expect(loaded).toBe(false);
      const { fileSystemProvider } = await binding;
      expect(loaded).toBe(true);
      expect(fileSystemProvider(servicesWith()).readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('edited one');
   });
});
