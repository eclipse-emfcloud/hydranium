/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ScratchWorkspace, makeScratchWorkspace } from '../src/testing/node/scratch-workspace.js';

/** Seed directory built per test, so the seeding assertions have real input. */
function makeSeed(): string {
   const seed = path.join(tmpdir(), `hydranium-seed-${process.pid}-${seedCounter++}`);
   mkdirSync(path.join(seed, 'nested'), { recursive: true });
   writeFileSync(path.join(seed, 'top.txt'), 'top', 'utf8');
   writeFileSync(path.join(seed, 'nested', 'deep.txt'), 'deep', 'utf8');
   return seed;
}
let seedCounter = 0;

const created: ScratchWorkspace[] = [];
const track = (workspace: ScratchWorkspace): ScratchWorkspace => {
   created.push(workspace);
   return workspace;
};

describe('makeScratchWorkspace', () => {
   afterEach(() => {
      created.splice(0).forEach(workspace => workspace.dispose());
   });

   it('creates an empty directory when given no seed', () => {
      const workspace = track(makeScratchWorkspace());
      expect(existsSync(workspace.root)).toBe(true);
      expect(workspace.root.startsWith(tmpdir())).toBe(true);
   });

   it('copies a seed directory recursively, leaving the seed untouched', () => {
      const seed = makeSeed();
      const workspace = track(makeScratchWorkspace({ seed }));

      expect(readFileSync(path.join(workspace.root, 'top.txt'), 'utf8')).toBe('top');
      expect(readFileSync(path.join(workspace.root, 'nested', 'deep.txt'), 'utf8')).toBe('deep');

      // The whole point of the helper: writing through the copy must not reach
      // the original, which is what protects a committed sample workspace from
      // a write-path test.
      workspace.write('top.txt', 'rewritten');
      expect(readFileSync(path.join(workspace.root, 'top.txt'), 'utf8')).toBe('rewritten');
      expect(readFileSync(path.join(seed, 'top.txt'), 'utf8')).toBe('top');
   });

   it('writes a nested file, creating parent directories, and returns its path', () => {
      const workspace = track(makeScratchWorkspace());

      const written = workspace.write('a/b/c.txt', 'content');

      expect(written).toBe(path.join(workspace.root, 'a', 'b', 'c.txt'));
      expect(readFileSync(written, 'utf8')).toBe('content');
      expect(workspace.resolve('a/b/c.txt')).toBe(written);
   });

   it('removes the directory on dispose, and tolerates a second call', () => {
      const workspace = makeScratchWorkspace();
      workspace.write('file.txt', 'x');
      const root = workspace.root;

      workspace.dispose();
      expect(existsSync(root)).toBe(false);
      // An `afterEach` may run twice over the same object, or after a failed
      // `beforeEach` that never populated it.
      expect(() => workspace.dispose()).not.toThrow();
   });

   it('gives each workspace its own directory', () => {
      const first = track(makeScratchWorkspace());
      const second = track(makeScratchWorkspace());

      expect(first.root).not.toBe(second.root);
      first.write('shared-name.txt', 'first');
      second.write('shared-name.txt', 'second');
      expect(readFileSync(first.resolve('shared-name.txt'), 'utf8')).toBe('first');
   });
});
