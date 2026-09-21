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
import { type WritableFileSystemProvider } from '../../../src/documents/ast-document-manager.js';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import {
   InMemoryFileSystemProvider,
   inMemoryFileSystem,
   type InMemoryFileSystemOptions
} from '../../../src/langium/workspace/in-memory-file-system-provider.js';
import { virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

const ROOT = 'file:///workspace';

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

function provider(options: InMemoryFileSystemOptions = {}, virtualDocuments?: Record<string, string>): InMemoryFileSystemProvider {
   return new InMemoryFileSystemProvider(servicesWith(virtualDocuments), options);
}

/** The two-project shape a workspace walk has to descend, at its shallowest. */
function seeded(): InMemoryFileSystemProvider {
   return provider({
      rootUri: ROOT,
      seed: {
         'alpha/one.a': 'content one',
         'alpha/nested/two.a': 'content two',
         'beta/three.b': 'content three'
      }
   });
}

function names(nodes: { uri: URI }[]): string[] {
   return nodes.map(node => node.uri.toString()).sort();
}

describe('InMemoryFileSystemProvider seeding', () => {
   it('joins relative seed keys onto rootUri', () => {
      expect(seeded().readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('content one');
   });

   it('takes seed keys as absolute URIs when no rootUri is given', () => {
      const files = provider({ seed: { 'test:///a.a': 'absolute' } });
      expect(files.readFileSync(URI.parse('test:///a.a'))).toBe('absolute');
   });

   it('is empty but usable with no seed at all', () => {
      const files = provider();
      expect(files.existsSync(URI.parse(`${ROOT}/a.a`))).toBe(false);
      files.setFile(URI.parse(`${ROOT}/a.a`), 'later');
      expect(files.readFileSync(URI.parse(`${ROOT}/a.a`))).toBe('later');
   });

   it('agrees with a URI round trip about percent-encoding, so a seeded key is findable', () => {
      // The seed is a record of plain strings; every later lookup arrives as a
      // URI the framework built. Without normalising the key on the way in,
      // `a b.a` and `a%20b.a` are two entries and the walk finds neither.
      const files = provider({ rootUri: ROOT, seed: { 'a b.a': 'spaced' } });
      expect(files.readFileSync(URI.parse(`${ROOT}/a b.a`))).toBe('spaced');
      expect(files.existsSync(URI.parse(`${ROOT}/a%20b.a`))).toBe(true);
   });
});

describe('InMemoryFileSystemProvider reads', () => {
   it('reads a file both sync and async', async () => {
      const files = seeded();
      await expect(files.readFile(URI.parse(`${ROOT}/beta/three.b`))).resolves.toBe('content three');
      expect(files.readFileSync(URI.parse(`${ROOT}/beta/three.b`))).toBe('content three');
   });

   it('decodes readBinary through the same content', () => {
      const bytes = seeded().readBinarySync(URI.parse(`${ROOT}/alpha/one.a`));
      expect(new TextDecoder().decode(bytes)).toBe('content one');
   });

   it('throws naming the URI when the file is absent', () => {
      expect(() => seeded().readFileSync(URI.parse(`${ROOT}/missing.a`))).toThrow(`No such file: ${ROOT}/missing.a`);
   });

   it('serves a registered virtual document instead of consulting the map', () => {
      // The framework re-reads a changed URI through this seam, and nothing in
      // the map backs a virtual URI — so without this the stdlib disappears on
      // the first rebuild that touches it.
      const uri = virtualUri('builtin', 'types.a');
      const files = provider({}, { [uri.toString()]: 'element Any' });
      expect(files.readFileSync(uri)).toBe('element Any');
   });

   it('falls through to the map for a virtual URI with no registered document', () => {
      const uri = virtualUri('builtin', 'types.a');
      const files = provider({ seed: { [uri.toString()]: 'from the map' } });
      expect(files.readFileSync(uri)).toBe('from the map');
   });
});

describe('InMemoryFileSystemProvider directories', () => {
   it('reports a file as a file and its parent as a directory', () => {
      const files = seeded();
      expect(files.statSync(URI.parse(`${ROOT}/alpha/one.a`))).toMatchObject({ isFile: true, isDirectory: false });
      expect(files.statSync(URI.parse(`${ROOT}/alpha`))).toMatchObject({ isFile: false, isDirectory: true });
   });

   it('synthesises a directory for every ancestor of a seeded file', () => {
      const files = seeded();
      expect(files.existsSync(URI.parse(ROOT))).toBe(true);
      expect(files.existsSync(URI.parse(`${ROOT}/alpha/nested`))).toBe(true);
   });

   it('lists files and subdirectories at one level, not recursively', () => {
      expect(names(seeded().readDirectorySync(URI.parse(`${ROOT}/alpha`)))).toEqual([`${ROOT}/alpha/nested`, `${ROOT}/alpha/one.a`]);
   });

   it('marks a listed subdirectory as a directory', () => {
      const nested = seeded()
         .readDirectorySync(URI.parse(`${ROOT}/alpha`))
         .find(node => node.uri.toString().endsWith('nested'));
      expect(nested).toMatchObject({ isFile: false, isDirectory: true });
   });

   it('answers the workspace root spelled with and without a trailing separator identically', () => {
      // Langium spells the root both ways depending on which walk asks, so a
      // provider that normalises in one place and not another reports the root
      // as absent to half the framework.
      const files = seeded();
      expect(files.existsSync(URI.parse(`${ROOT}/`))).toBe(true);
      expect(files.statSync(URI.parse(`${ROOT}/`))).toMatchObject({ isDirectory: true });
      expect(names(files.readDirectorySync(URI.parse(`${ROOT}/`)))).toEqual(names(files.readDirectorySync(URI.parse(ROOT))));
   });

   it('returns an empty listing rather than throwing for a path with no children', () => {
      expect(seeded().readDirectorySync(URI.parse(`${ROOT}/nowhere`))).toEqual([]);
   });

   it('throws naming the URI when nothing is there at all', () => {
      expect(() => seeded().statSync(URI.parse(`${ROOT}/nowhere`))).toThrow(`No such file or directory: ${ROOT}/nowhere`);
   });

   it('stops reporting a directory once its last file is deleted', () => {
      const files = seeded();
      files.deleteFile(URI.parse(`${ROOT}/beta/three.b`));
      expect(files.existsSync(URI.parse(`${ROOT}/beta`))).toBe(false);
      expect(names(files.readDirectorySync(URI.parse(ROOT)))).toEqual([`${ROOT}/alpha`]);
   });
});

describe('InMemoryFileSystemProvider writes', () => {
   it('creates a file and its implied ancestors in one write', async () => {
      const files = seeded();
      await files.writeFile(URI.parse(`${ROOT}/gamma/deep/four.a`), 'content four');
      expect(files.readFileSync(URI.parse(`${ROOT}/gamma/deep/four.a`))).toBe('content four');
      expect(files.existsSync(URI.parse(`${ROOT}/gamma`))).toBe(true);
      expect(files.existsSync(URI.parse(`${ROOT}/gamma/deep`))).toBe(true);
   });

   it('replaces existing content', async () => {
      const files = seeded();
      await files.writeFile(URI.parse(`${ROOT}/alpha/one.a`), 'replaced');
      expect(files.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('replaced');
   });

   it('deletes silently when nothing is there', () => {
      expect(() => seeded().deleteFile(URI.parse(`${ROOT}/missing.a`))).not.toThrow();
   });

   it('omits mtimeMs and realpath rather than stubbing them', () => {
      // Both are optional on the seam and the framework degrades on absence.
      // Stubbing either would claim a disk answer this provider cannot give.
      const seam: WritableFileSystemProvider = seeded();
      expect(seam.mtimeMs).toBeUndefined();
      expect(seam.realpath).toBeUndefined();
   });
});

describe('inMemoryFileSystem', () => {
   it('binds a provider carrying writeFile, which is what the slot requires', () => {
      // A provider without `writeFile` is silently replaced by the empty
      // default, so the slot's acceptance test is the presence of this method.
      const { fileSystemProvider } = inMemoryFileSystem({ rootUri: ROOT, seed: { 'alpha/one.a': 'content one' } });
      const bound = fileSystemProvider(servicesWith());
      expect(typeof bound.writeFile).toBe('function');
      expect(bound.readFileSync(URI.parse(`${ROOT}/alpha/one.a`))).toBe('content one');
   });

   it('passes its options through to the provider', () => {
      const { fileSystemProvider } = inMemoryFileSystem({ logName: 'TestFileSystem' });
      expect(fileSystemProvider(servicesWith())).toBeInstanceOf(InMemoryFileSystemProvider);
   });
});

/**
 * Every read agrees about a registered virtual document. Contract: a provider
 * that serves the document's text and then reports nothing there cannot be
 * probed before a read, so the registry is consulted by the whole surface and
 * not only by `readFileSync`.
 *
 * Asserted alongside a map that does NOT hold the URI, so a pass cannot come
 * from the map answering instead of the registry.
 */
describe('InMemoryFileSystemProvider agreement across the read surface', () => {
   const uri = virtualUri('builtin', 'types.a');
   const files = (): InMemoryFileSystemProvider => provider({}, { [uri.toString()]: 'element Any' });

   it('reports the document present', async () => {
      // The map is empty, so `true` can only have come from the registry.
      expect(provider().existsSync(uri)).toBe(false);
      expect(files().existsSync(uri)).toBe(true);
      expect(await files().exists(uri)).toBe(true);
   });

   it('stats the document as a file', async () => {
      expect(files().statSync(uri)).toMatchObject({ isFile: true, isDirectory: false });
      expect(await files().stat(uri)).toMatchObject({ isFile: true, isDirectory: false });
   });

   it('reads the document as text and as bytes', async () => {
      expect(files().readFileSync(uri)).toBe('element Any');
      expect(files().readBinarySync(uri)).toEqual(new TextEncoder().encode('element Any'));
      expect(await files().readBinary(uri)).toEqual(new TextEncoder().encode('element Any'));
   });

   it('still reports an unregistered virtual URI absent', () => {
      expect(provider().existsSync(virtualUri('builtin', 'absent.a'))).toBe(false);
      expect(() => provider().statSync(virtualUri('builtin', 'absent.a'))).toThrow();
   });
});

/**
 * A miss on an async read arrives as a rejection. Contract: the sync twins
 * throw, and the async ones reject — a synchronous throw from a method
 * declared to return a promise escapes the chain, so a caller batching several
 * URIs cannot handle the miss it asked about.
 */
describe('InMemoryFileSystemProvider async misses reject', () => {
   const missing = URI.parse(`${ROOT}/missing.a`);

   it('rejects rather than throwing synchronously', async () => {
      // `rejects` discriminates on its own: a synchronous throw never hands the
      // matcher a promise, and the case errors out instead of passing.
      await expect(seeded().readFile(missing)).rejects.toThrow();
      await expect(seeded().readBinary(missing)).rejects.toThrow();
      await expect(seeded().stat(missing)).rejects.toThrow();
   });

   it('is catchable when several URIs are read together', async () => {
      // The shape a synchronous throw actually breaks: it fires while the
      // argument array is still being built, so `Promise.all` never returns a
      // promise and neither handler below can run.
      const files = seeded();
      const settled = await Promise.all([files.readFile(URI.parse(`${ROOT}/alpha/one.a`)), files.readFile(missing)]).then(
         () => 'resolved',
         (err: unknown) => `rejected: ${String(err)}`
      );
      expect(settled).toContain('No such file');
   });

   it('still resolves a hit', async () => {
      await expect(seeded().readFile(URI.parse(`${ROOT}/alpha/one.a`))).resolves.toBe('content one');
   });
});
