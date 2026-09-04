/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
   chmodSync,
   linkSync,
   lstatSync,
   mkdirSync,
   mkdtempSync,
   readFileSync,
   readdirSync,
   rmSync,
   statSync,
   symlinkSync,
   writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { URI, UriUtils } from '@hydranium/langium';
import { DefaultFileSystemProvider } from '../../src/node/node-file-system-provider.js';
import { makeNoopSharedServices } from '../../src/testing/index.js';
import { makeStubSelfSaveRegistry } from '../../src/testing/stub-self-save-registry.js';

/**
 * The `realpath` primitive — the behaviour {@link RealpathDocumentUriPolicy}
 * delegates onto the filesystem seam. Contract:
 * - resolve a `file:` URI to its real on-disk path (symlinks collapsed);
 * - return `undefined` when the filesystem knows the path is absent;
 * - pass a non-`file:` URI through unchanged (cannot be statted → treat as present).
 */
describe('DefaultFileSystemProvider.realpath', () => {
   // A symlinked *directory* makes the resolved (real) path differ from the
   // syntactic path on every platform, so the assertions distinguish a genuine
   // realpath resolution from a passthrough.
   let root: string;
   let realDir: string;
   let linkDir: string;
   let symlinkSupported = true;
   let provider: DefaultFileSystemProvider;

   const services = makeNoopSharedServices({
      workspace: { SelfSaveRegistry: makeStubSelfSaveRegistry() }
   });

   /** URI of `name` addressed through the symlinked directory. */
   const viaLink = (name: string): URI => URI.file(join(linkDir, name));
   /** The real (resolved) URI of `name`. */
   const real = (name: string): URI => URI.file(join(realDir, name));

   beforeAll(() => {
      provider = new DefaultFileSystemProvider(services);
      root = mkdtempSync(join(tmpdir(), 'hydranium-realpath-'));
      realDir = join(root, 'real');
      linkDir = join(root, 'link');
      mkdirSync(realDir);
      writeFileSync(join(realDir, 'present.fake'), 'content');
      try {
         symlinkSync(realDir, linkDir, 'dir');
      } catch {
         // Windows without the symlink privilege — skip symlink-dependent cases.
         symlinkSupported = false;
      }
   });

   afterAll(() => {
      rmSync(root, { recursive: true, force: true });
   });

   it('resolves a symlinked path to its real on-disk path', context => {
      // `context.skip()`, not an early `return`: a return reports GREEN having
      // asserted nothing, which is indistinguishable from a real pass. The
      // predicate is only known after `beforeAll` has tried the symlink, so
      // `it.skipIf` — evaluated at collection — cannot see it.
      context.skip(!symlinkSupported, 'symlinkSync denied on this platform');
      const resolved = provider.realpath(viaLink('present.fake'));
      expect(resolved && UriUtils.normalize(resolved)).toBe(UriUtils.normalize(real('present.fake')));
   });

   it('returns undefined when the filesystem knows the path is absent', () => {
      expect(provider.realpath(URI.file(join(realDir, 'absent.fake')))).toBeUndefined();
   });

   it('passes a non-file URI through unchanged (cannot stat → treated as present, never undefined)', () => {
      const builtin = URI.parse('builtin:///Element.fake');
      expect(provider.realpath(builtin)).toBe(builtin);
   });
});

/**
 * The `mtimeMs` primitive and its one consumer. Contract:
 * - report the file's on-disk mtime for a `file:` URI;
 * - return `undefined` when the path cannot be statted, so callers treat the
 *   mtime as unknown rather than failing;
 * - `writeFile` records the POST-write mtime with the self-save registry, which
 *   is what lets the watcher recognise its own echo later.
 *
 * Real filesystem on purpose: this provider IS the seam onto `fsp.stat`, so
 * stubbing it would leave nothing under test. Consumers that merely read the
 * mtime (e.g. `HydraniumDocumentUpdateHandler`) inject a constant instead.
 */
describe('DefaultFileSystemProvider.mtimeMs', () => {
   let root: string;
   let provider: DefaultFileSystemProvider;
   let selfSaveRegistry: ReturnType<typeof makeStubSelfSaveRegistry>;

   beforeAll(() => {
      selfSaveRegistry = makeStubSelfSaveRegistry();
      provider = new DefaultFileSystemProvider(makeNoopSharedServices({ workspace: { SelfSaveRegistry: selfSaveRegistry } }));
      root = mkdtempSync(join(tmpdir(), 'hydranium-mtime-'));
      writeFileSync(join(root, 'present.fake'), 'content');
   });

   afterAll(() => {
      rmSync(root, { recursive: true, force: true });
   });

   it('reports the on-disk mtime of an existing file', async () => {
      const file = join(root, 'present.fake');
      // `statSync` is the oracle, not a tautology: the provider still has to
      // derive `fsPath` from the URI and pick `mtimeMs` off the stat result.
      expect(await provider.mtimeMs(URI.file(file))).toBe(statSync(file).mtimeMs);
   });

   it('returns undefined when the file is absent', async () => {
      expect(await provider.mtimeMs(URI.file(join(root, 'absent.fake')))).toBeUndefined();
   });

   it('returns undefined for a URI that cannot be statted', async () => {
      expect(await provider.mtimeMs(URI.parse('builtin:///Element.fake'))).toBeUndefined();
   });

   it('writeFile registers the post-write mtime with the self-save registry', async () => {
      const file = join(root, 'nested', 'written.fake');
      await provider.writeFile(URI.file(file), 'written content');
      // Parent directory is created on demand, and the content landed.
      expect(statSync(file).isFile()).toBe(true);
      expect(selfSaveRegistry.registerCalls).toEqual([{ fsPath: URI.file(file).fsPath, mtimeMs: statSync(file).mtimeMs }]);
   });
});

/**
 * `writeFile` under two racing writers. Contract:
 * - every state a reader can observe is one COMPLETE revision, never a
 *   truncated or half-written file;
 * - nothing is serialised, so which of the two writers wins is not asserted —
 *   a lost write is the framework's documented single-writer limit, and an
 *   assertion that both survived would test a promise nobody made.
 *
 * Sequential writes never tear, so the writers have to overlap: each write is
 * large enough that its truncate-then-fill is several event-loop turns wide,
 * and the reader samples between them. The sample floor is asserted because a
 * reader that never got the loop back would report zero torn samples for the
 * same reason a correct implementation does.
 */
describe('DefaultFileSystemProvider.writeFile under concurrent writers', () => {
   let root: string;
   let provider: DefaultFileSystemProvider;

   const SIZE = 2 * 1024 * 1024;
   const ROUNDS = 4;
   const before = 'c'.repeat(SIZE);
   const first = 'a'.repeat(SIZE);
   const second = 'b'.repeat(SIZE);

   beforeAll(() => {
      provider = new DefaultFileSystemProvider(makeNoopSharedServices({ workspace: { SelfSaveRegistry: makeStubSelfSaveRegistry() } }));
      root = mkdtempSync(join(tmpdir(), 'hydranium-atomic-write-'));
   });

   afterAll(() => {
      rmSync(root, { recursive: true, force: true });
   });

   it('never exposes a partial file to a concurrent reader', async () => {
      const file = join(root, 'contended.fake');
      const uri = URI.file(file);
      const complete = new Set([before, first, second]);
      const torn: string[] = [];
      let samples = 0;
      let writing = true;

      // Describes a sample without embedding megabytes in the failure message.
      const shape = (text: string): string => `${text.length} bytes, [${new Set(text).size} distinct chars]`;

      const sample = async (): Promise<void> => {
         while (writing) {
            samples++;
            try {
               const seen = readFileSync(file, 'utf8');
               if (!complete.has(seen)) {
                  torn.push(shape(seen));
               }
            } catch {
               // ENOENT is itself a torn state here: the file exists before the
               // first round and must never vanish, so record it as one.
               torn.push('absent');
            }
            await new Promise(resolve => setImmediate(resolve));
         }
      };

      writeFileSync(file, before);
      const reader = sample();
      for (let round = 0; round < ROUNDS; round++) {
         await Promise.all([provider.writeFile(uri, first), provider.writeFile(uri, second)]);
      }
      writing = false;
      await reader;

      expect(torn).toEqual([]);
      // A run that never yielded to the reader proves nothing about tearing.
      expect(samples).toBeGreaterThan(ROUNDS * 4);
      expect(complete.has(readFileSync(file, 'utf8'))).toBe(true);
   });

   // The success path sweeps the staging file by moving it, so only a FAILED
   // write exercises the cleanup — and a leftover staging file is the shape a
   // later workspace scan or a `--force` clean has to reason about.
   it('removes the staging file and rethrows when the write cannot complete', async () => {
      const blocked = join(root, 'blocked.fake');
      // A non-empty directory at the target makes `rename` fail after the
      // staging file has already been written, which is the only ordering that
      // leaves something to clean up.
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'occupant'), 'x');

      await expect(provider.writeFile(URI.file(blocked), 'content')).rejects.toThrow();
      expect(readdirSync(root).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
   });
});

/**
 * What a staged replacement has to carry over from the file it replaces, since
 * a `rename` starts from a NEW file rather than from the target. Contract:
 * - a symlinked target keeps its link, and the file it points at is what gets
 *   replaced — an in-place write follows the link, so anything less is a
 *   regression against the plain overwrite this replaced;
 * - an existing target's permission bits survive the write;
 * - a target sharing its inode with another name is written IN PLACE, because a
 *   rename would leave that other name on the previous revision with nothing
 *   raised, and a single-link target still goes through the rename — so the
 *   fallback has to be observable in BOTH directions or an inverted test for
 *   `nlink` would turn every write non-atomic unnoticed.
 *
 * Ownership, extended attributes and ACLs are documented as NOT carried over,
 * so nothing here asserts them.
 */
describe('DefaultFileSystemProvider.writeFile preserves the target it replaces', () => {
   let root: string;
   let provider: DefaultFileSystemProvider;
   let symlinkSupported = true;
   let modeSupported = true;
   /**
    * Whether this filesystem both accepts a `link()` and reports the resulting
    * `nlink` — the two things the in-place fallback is selected by. Where either
    * is missing the fallback cannot fire, so the case is skipped rather than
    * failed.
    */
   let hardLinkSupported = true;
   /** Whether `ino` discriminates, which is what tells a rename from an in-place write. */
   let inodeObservable = true;
   /** Mode a fresh write lands on here (umask-dependent), measured rather than computed. */
   let defaultMode: number;
   /** A mode that DIFFERS from `defaultMode`, so a lost mode cannot read as preserved. */
   let carriedMode: number;

   beforeAll(() => {
      provider = new DefaultFileSystemProvider(makeNoopSharedServices({ workspace: { SelfSaveRegistry: makeStubSelfSaveRegistry() } }));
      root = mkdtempSync(join(tmpdir(), 'hydranium-write-preserve-'));

      const probe = join(root, 'probe.fake');
      writeFileSync(probe, '');
      defaultMode = statSync(probe).mode & 0o777;
      carriedMode = defaultMode === 0o600 ? 0o640 : 0o600;
      // Windows honours only the read-only bit, so a chmod that does not stick
      // is a platform limit rather than a failure — measure it here, because a
      // test that cannot observe the mode would report GREEN having proved
      // nothing about whether the write carried it.
      chmodSync(probe, carriedMode);
      modeSupported = (statSync(probe).mode & 0o777) === carriedMode;

      try {
         symlinkSync(probe, join(root, 'probe-link.fake'), 'file');
      } catch {
         symlinkSupported = false;
      }

      // A separate probe, because a hard link to `probe` would leave every
      // later reader of it looking at an nlink of 2.
      const linkProbe = join(root, 'link-probe.fake');
      writeFileSync(linkProbe, '');
      inodeObservable = statSync(linkProbe).ino !== 0;
      try {
         linkSync(linkProbe, join(root, 'link-probe-second.fake'));
         hardLinkSupported = statSync(linkProbe).nlink === 2;
      } catch {
         hardLinkSupported = false;
      }
   });

   afterAll(() => {
      rmSync(root, { recursive: true, force: true });
   });

   it('replaces the file a symlinked target points at, leaving the link a link', async context => {
      context.skip(!symlinkSupported, 'symlinkSync denied on this platform');
      // The real file sits in a DIFFERENT directory from the link on purpose. A
      // same-directory pair still discriminates on `lstat`, but only a separate
      // directory shows the staging file following the RESOLVED destination —
      // which is what keeps the rename inside one filesystem when a link
      // crosses one.
      const linkDir = join(root, 'links');
      const realDir = join(root, 'store');
      mkdirSync(linkDir);
      mkdirSync(realDir);
      const realFile = join(realDir, 'model.fake');
      const link = join(linkDir, 'model.fake');
      writeFileSync(realFile, 'previous');
      symlinkSync(realFile, link, 'file');

      await provider.writeFile(URI.file(link), 'replacement');

      // Reading back THROUGH the link is satisfied by a regular file sitting at
      // the link's path, so it passes in the broken state too and is asserted
      // last, as a consistency check rather than as the discriminator.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(realFile, 'utf8')).toBe('replacement');
      expect(readFileSync(link, 'utf8')).toBe('replacement');
      // Staged beside the destination, and swept from both candidate directories.
      expect(readdirSync(realDir).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
      expect(readdirSync(linkDir).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
   });

   it('carries the existing permission bits onto the replacement', async context => {
      context.skip(!modeSupported, 'chmod has no effect on this platform');
      const file = join(root, 'restricted.fake');
      writeFileSync(file, 'previous');
      chmodSync(file, carriedMode);

      await provider.writeFile(URI.file(file), 'replacement');

      expect(statSync(file).mode & 0o777).toBe(carriedMode);
      // Without this the assertion above could be satisfied by a write that
      // carried nothing and merely landed on the process default.
      expect(carriedMode).not.toBe(defaultMode);
      expect(readFileSync(file, 'utf8')).toBe('replacement');
   });

   it('leaves a created file on the process default, having nothing to carry', async () => {
      const file = join(root, 'created.fake');
      await provider.writeFile(URI.file(file), 'fresh');
      expect(readFileSync(file, 'utf8')).toBe('fresh');
      expect(statSync(file).mode & 0o777).toBe(defaultMode);
   });

   it('writes a multiply-linked target in place, so every name sees the new content', async context => {
      context.skip(!hardLinkSupported, 'hard links unavailable or nlink unreported on this filesystem');
      const primary = join(root, 'linked.fake');
      const secondary = join(root, 'linked-alias.fake');
      writeFileSync(primary, 'previous');
      linkSync(primary, secondary);
      // The precondition the fallback keys off. Without it the write takes the
      // staged branch and the assertions below say nothing about the fallback.
      expect(statSync(primary).nlink).toBe(2);

      await provider.writeFile(URI.file(primary), 'replacement');

      expect(statSync(primary).nlink).toBe(2);
      // Surviving link and landed content are asserted TOGETHER: a write that
      // did nothing at all satisfies the nlink assertion on its own, and reading
      // only `primary` cannot tell a preserved inode from a fresh file that
      // happens to sit at that path.
      expect(readFileSync(primary, 'utf8')).toBe('replacement');
      expect(readFileSync(secondary, 'utf8')).toBe('replacement');
      expect(readdirSync(root).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
   });

   it('still stages a single-link target, replacing it with a new inode', async context => {
      context.skip(!inodeObservable, 'ino is not reported on this filesystem');
      const file = join(root, 'single-link.fake');
      writeFileSync(file, 'previous');
      const replaced = statSync(file);
      expect(replaced.nlink).toBe(1);

      await provider.writeFile(URI.file(file), 'replacement');

      // The inode is the only local observable that separates the two branches:
      // an in-place write keeps it, a rename cannot, since the staging file is
      // created while the old one is still linked. Were the nlink test inverted,
      // every write would quietly stop being indivisible and only this reddens.
      expect(statSync(file).ino).not.toBe(replaced.ino);
      expect(readFileSync(file, 'utf8')).toBe('replacement');
   });
});
