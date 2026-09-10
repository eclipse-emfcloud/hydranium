/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubWritableFileSystem` and the `makeStubSelfSaveRegistry` it notifies,
 * measured against the real `SelfSaveRegistry` on the one claim that couples
 * them.
 *
 * Both stubs' picked members ride `Pick<…>` in shipped source, so their
 * signatures already fail `npm run build`. The claim no compiler sees is the
 * one the file-system stub's doc comment makes: that its `writeFile` "stands in
 * for `DefaultFileSystemProvider.writeFile`, which registers the written file's
 * real mtime so the watcher echo for the server's own write is suppressed".
 *
 * That is only true if the pair it registers is the pair the REAL registry
 * would match on, and the key is the part that can silently drift: the registry
 * keys by `fsPath` specifically, to avoid URI-form mismatches. So the recorded
 * pair is replayed into a real `SelfSaveRegistry` here, with the near-miss
 * cases asserted too — a suite that only checked `registerCalls` was populated
 * would pass with the URI string recorded instead of the path, and the
 * suppression it stands for would silently stop working.
 */

import { describe, expect, it } from 'vitest';
import { URI } from '@hydranium/langium';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { DefaultSelfSaveRegistry } from '../../src/documents/self-save-registry.js';
import { makeStubSelfSaveRegistry, makeStubWritableFileSystem } from '../../src/testing/index.js';

const URI_A = URI.parse('file:///ws/a.fake');
const URI_B = URI.parse('file:///ws/b.fake');

describe('makeStubWritableFileSystem — the write record', () => {
   it('records every write in call order, keyed by URI string', async () => {
      const fileSystem = makeStubWritableFileSystem();
      await fileSystem.writeFile(URI_A, 'first');
      await fileSystem.writeFile(URI_B, 'second');
      await fileSystem.writeFile(URI_A, 'third');

      // ABSOLUTE list: a stub that deduplicated by URI, or overwrote in place,
      // would still leave a non-empty array for a length assertion to pass on.
      expect(fileSystem.writes).toEqual([
         { uri: URI_A.toString(), content: 'first' },
         { uri: URI_B.toString(), content: 'second' },
         { uri: URI_A.toString(), content: 'third' }
      ]);
   });

   it('answers the read paths as empty, and drops the record on reset', async () => {
      const fileSystem = makeStubWritableFileSystem();
      await fileSystem.writeFile(URI_A, 'written');

      // Documented as unbacked: the stub records the save path and reads answer
      // nothing, so a test that needs a read wants the real provider.
      await expect(fileSystem.readFile(URI_A)).resolves.toBe('');
      await expect(fileSystem.readDirectory(URI.parse('file:///ws'))).resolves.toEqual([]);

      fileSystem.reset();
      expect(fileSystem.writes).toEqual([]);
   });

   it('writes without a registry when it was constructed without one', async () => {
      const fileSystem = makeStubWritableFileSystem();

      // The registry argument is optional; a stub that dereferenced it
      // unconditionally would throw here rather than record.
      await expect(fileSystem.writeFile(URI_A, 'written')).resolves.toBeUndefined();
      expect(fileSystem.writes).toHaveLength(1);
   });
});

describe('makeStubWritableFileSystem — the self-save notification, against the real SelfSaveRegistry', () => {
   it('registers the fsPath and an mtime the real registry matches on', async () => {
      const stubRegistry = makeStubSelfSaveRegistry();
      const fileSystem = makeStubWritableFileSystem(stubRegistry);
      const before = Date.now();
      await fileSystem.writeFile(URI_A, 'written');
      const after = Date.now();

      expect(stubRegistry.registerCalls).toHaveLength(1);
      const [call] = stubRegistry.registerCalls;
      expect(call.fsPath).toBe(URI_A.fsPath);
      expect(call.mtimeMs).toBeGreaterThanOrEqual(before);
      expect(call.mtimeMs).toBeLessThanOrEqual(after);

      // Replay the recorded pair into the real registry: this is what the
      // suppression the stub stands in for actually consults.
      const clock = makeFakeClock({ now: call.mtimeMs });
      const real = new DefaultSelfSaveRegistry({ Clock: clock });
      real.register(call.fsPath, call.mtimeMs);

      expect(real.isRegistered(call.fsPath, call.mtimeMs)).toBe(true);
      // The near misses are what make the line above mean something: the real
      // registry keys by fsPath and matches by exact mtime, so a stub recording
      // the URI string or a rounded mtime would register an entry that never
      // suppresses anything.
      expect(real.isRegistered(URI_A.toString(), call.mtimeMs)).toBe(false);
      expect(real.isRegistered(call.fsPath, call.mtimeMs + 1)).toBe(false);
   });

   it('notifies the registry once per write, and stops after the registry is reset', async () => {
      const stubRegistry = makeStubSelfSaveRegistry();
      const fileSystem = makeStubWritableFileSystem(stubRegistry);

      await fileSystem.writeFile(URI_A, 'first');
      await fileSystem.writeFile(URI_B, 'second');
      expect(stubRegistry.registerCalls.map(call => call.fsPath)).toEqual([URI_A.fsPath, URI_B.fsPath]);

      stubRegistry.reset();
      expect(stubRegistry.registerCalls).toEqual([]);
      // The two records are independent: resetting the registry must not clear
      // the write log, which is what a shared backing array would do.
      expect(fileSystem.writes).toHaveLength(2);
   });
});
