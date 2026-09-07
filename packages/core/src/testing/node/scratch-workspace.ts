/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Throwaway on-disk workspace directories for tests.
 *
 * # Why a framework helper rather than four lines per test
 *
 * Any test that drives a **write path** needs one, and the reason is not
 * obvious enough to rediscover per suite. The writes themselves are usually
 * in-memory — `ModelService.update` goes to the multi-client text store, and
 * only `save` reaches disk — but a rebuild also runs the integrity rules, and
 * their default `'silent'` sync mode persists repairs through
 * `WritableFileSystemProvider.writeFile`. So a write-path test pointed at a
 * committed sample workspace can **rewrite the sample files**, after which
 * every later run asserts against already-repaired input: a suite that passes
 * while testing nothing. The same applies to a fixture built in place, which
 * additionally loses its explanatory comments, because the write-back goes
 * through the serializer.
 *
 * The second reason is cleanup. Hand-rolled `mkdtempSync` without a matching
 * `rmSync` leaks a directory per test run into the OS temp dir, which nobody
 * notices until a CI box fills up.
 *
 * # Two shapes, because both occur
 *
 * - **Seeded** — copy a committed sample workspace and work on the copy. Use
 *   this when the test wants realistic, linked, multi-file input.
 * - **Empty, then written** — start bare and author the files the test needs.
 *   Use this when the point IS the file layout: project discovery, document
 *   identity, symlinks, a deliberately broken descriptor.
 *
 * Both are the same object; `seed` is optional and {@link ScratchWorkspace.write}
 * is available either way, so a seeded workspace can still gain a file.
 *
 * # Not a Langium anything
 *
 * This deliberately knows nothing about services, documents or builds — it
 * makes a directory and removes it. The caller decides what to initialize over
 * it (`initializeWorkspaceProgrammatically` for the editor-equivalent path,
 * `buildWorkspaceProgrammatically` for the eager one), because that choice is
 * itself often what a test is pinning.
 */

import { URI } from '@hydranium/langium';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Options for {@link makeScratchWorkspace}. */
export interface ScratchWorkspaceOptions {
   /**
    * Directory to copy in as the starting content, recursively. Omit for an
    * empty workspace.
    */
   readonly seed?: string;
   /**
    * Prefix for the temp directory name, so a leaked directory is traceable to
    * the suite that made it. Defaults to `hydranium-scratch-`.
    */
   readonly prefix?: string;
}

/** A temp directory with a cleanup hook. */
export interface ScratchWorkspace {
   /** Absolute path of the workspace root. */
   readonly root: string;
   /**
    * Write a file under {@link root}, creating parent directories. Returns the
    * absolute path, so a caller can hand it straight to a URI.
    */
   write(relativePath: string, content: string): string;
   /** Absolute path of `relativePath` under {@link root}, without writing. */
   resolve(relativePath: string): string;
   /**
    * `file:` URI string of `relativePath` under {@link root}, or of the root
    * itself when called with no argument. This is what the wire carries, so it
    * is what a test hands to `initialize`, `openModelDocument` or any request
    * keyed by URI.
    *
    * **Exists so `` `file://${workspace.root}` `` cannot be hand-rolled**, which
    * is not a style preference. {@link root} comes from `mkdtempSync` and is
    * therefore OS-NATIVE: on Windows the template form yields
    * `file://C:\dir\…`, where the drive letter parses as the authority and the
    * backslashes are not separators, so every URI comparison in the suite fails
    * against the `file:///c:/dir/…` the server produces. `URI.file` applies
    * the drive-letter lowercasing, the third slash and the percent-encoding that
    * makes the two agree.
    */
   uri(relativePath?: string): string;
   /**
    * Remove the directory. Idempotent, and safe to call from an `afterEach`
    * that may run after a failed `beforeEach`.
    */
   dispose(): void;
}

/**
 * Create a throwaway workspace directory. The caller owns teardown — pair the
 * returned {@link ScratchWorkspace.dispose} with an `afterEach`.
 */
export function makeScratchWorkspace(options: ScratchWorkspaceOptions = {}): ScratchWorkspace {
   const root = mkdtempSync(path.join(tmpdir(), options.prefix ?? 'hydranium-scratch-'));
   if (options.seed) {
      cpSync(options.seed, root, { recursive: true });
   }
   let disposed = false;
   const resolve = (relativePath: string): string => path.join(root, relativePath);
   return {
      root,
      resolve,
      uri(relativePath?: string) {
         return URI.file(relativePath === undefined ? root : resolve(relativePath)).toString();
      },
      write(relativePath, content) {
         const target = resolve(relativePath);
         mkdirSync(path.dirname(target), { recursive: true });
         writeFileSync(target, content, 'utf8');
         return target;
      },
      dispose() {
         if (disposed) {
            return;
         }
         disposed = true;
         // `force` so a test that already removed the directory, or never got
         // far enough to populate it, does not fail teardown.
         rmSync(root, { recursive: true, force: true });
      }
   };
}
