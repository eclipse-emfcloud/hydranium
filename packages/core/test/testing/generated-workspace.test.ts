/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeGeneratedWorkspace` — the four properties the scaffolding exists to
 * guarantee, each of which a generator would otherwise have to get right on its
 * own: byte reproducibility at a seed, the marker as an overwrite permit, LF
 * normalisation, and the per-extension tally.
 *
 * Content emission is the caller's, so every case here emits deliberately
 * neutral files rather than any language's syntax.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
   GENERATED_WORKSPACE_MARKER,
   type GeneratedWorkspaceWriter,
   makeGeneratedWorkspace
} from '../../src/testing/node/generated-workspace.js';

const roots: string[] = [];

/** A fresh throwaway root, remembered for teardown. */
function scratchRoot(label: string): string {
   const root = mkdtempSync(path.join(tmpdir(), `hydranium-generated-${label}-`));
   roots.push(root);
   return root;
}

/** Every file under `directory`, keyed by its root-relative POSIX path. */
function readTree(directory: string): Map<string, string> {
   const contents = new Map<string, string>();
   const walk = (current: string): void => {
      for (const entry of readdirSync(current).sort()) {
         const absolute = path.join(current, entry);
         if (statSync(absolute).isDirectory()) {
            walk(absolute);
         } else {
            contents.set(path.relative(directory, absolute).split(path.sep).join('/'), readFileSync(absolute, 'utf8'));
         }
      }
   };
   walk(directory);
   return contents;
}

/** An emitter whose content is drawn from the seeded stream, in a fixed order. */
function emitSeeded(files: number): (writer: GeneratedWorkspaceWriter) => void {
   return writer => {
      writer.directory('nested');
      for (let index = 0; index < files; index++) {
         writer.write(`nested/item-${index}.one`, `value ${writer.randomInt(0, 1000)}\n`);
      }
      writer.write('notes.txt', `tail ${writer.random()}\n`);
   };
}

afterAll(() => {
   for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
   }
});

describe('makeGeneratedWorkspace', () => {
   it('reproduces the corpus byte for byte at one seed and changes it at another', () => {
      const first = readTree(makeGeneratedWorkspace({ root: scratchRoot('a'), generator: 'probe', seed: 7, emit: emitSeeded(4) }).root);
      const again = readTree(makeGeneratedWorkspace({ root: scratchRoot('b'), generator: 'probe', seed: 7, emit: emitSeeded(4) }).root);
      const other = readTree(makeGeneratedWorkspace({ root: scratchRoot('c'), generator: 'probe', seed: 8, emit: emitSeeded(4) }).root);

      expect([...again.entries()]).toEqual([...first.entries()]);
      // Same files, different content — which is what proves the seed reaches
      // the content rather than being recorded and ignored.
      expect([...other.keys()]).toEqual([...first.keys()]);
      expect([...other.entries()]).not.toEqual([...first.entries()]);
   });

   it('refuses to overwrite a directory it did not generate, and leaves it intact', () => {
      const foreign = scratchRoot('foreign');
      writeFileSync(path.join(foreign, 'precious.txt'), 'not mine to delete');

      expect(() => makeGeneratedWorkspace({ root: foreign, generator: 'probe', emit: emitSeeded(1) })).toThrow(/Refusing to overwrite/);
      // Asserting survival as well as the throw: a guard that threw AFTER the
      // wipe would satisfy the message assertion alone.
      expect(readTree(foreign).has('precious.txt')).toBe(true);
   });

   it('wipes and regenerates a directory that carries the marker', () => {
      const root = scratchRoot('permit');
      makeGeneratedWorkspace({ root, generator: 'probe', seed: 1, emit: emitSeeded(3) });
      writeFileSync(path.join(root, 'nested', 'stale.one'), 'left over from a previous shape');

      const summary = makeGeneratedWorkspace({ root, generator: 'probe', seed: 1, emit: emitSeeded(3) });

      expect(readTree(root).has('nested/stale.one')).toBe(false);
      expect(summary.files['.one']).toBe(3);
   });

   it('records the generator, the seed and the parameters in the marker', () => {
      const root = scratchRoot('marker');

      makeGeneratedWorkspace({ root, generator: 'probe/one', parameters: { size: 3 }, seed: 11, emit: emitSeeded(1) });

      expect(JSON.parse(readTree(root).get(GENERATED_WORKSPACE_MARKER) ?? '{}')).toEqual({
         generator: 'probe/one',
         seed: 11,
         size: 3
      });
   });

   it('leaves the marker in place when emission throws, so the next run may still clear the root', () => {
      const root = scratchRoot('partial');

      expect(() =>
         makeGeneratedWorkspace({
            root,
            generator: 'probe',
            emit(writer) {
               writer.write('half.one', 'written\n');
               throw new Error('emission failed');
            }
         })
      ).toThrow('emission failed');

      // The partial corpus is on disk AND permitted, which is the whole reason
      // the marker is written before `emit` rather than after it.
      const tree = readTree(root);
      expect(tree.has('half.one')).toBe(true);
      expect(tree.has(GENERATED_WORKSPACE_MARKER)).toBe(true);
      expect(() => makeGeneratedWorkspace({ root, generator: 'probe', emit: emitSeeded(1) })).not.toThrow();
   });

   it('tallies by extension, excluding the marker, and counts the total', () => {
      const summary = makeGeneratedWorkspace({
         root: scratchRoot('tally'),
         generator: 'probe',
         emit(writer) {
            writer.write('a.one', 'a\n');
            writer.write('b.one', 'b\n');
            writer.write('c.two', 'c\n');
            writer.write('README.md', 'd\n');
         }
      });

      expect(summary.files).toEqual({ '.one': 2, '.two': 1, '.md': 1 });
      // The marker is written by the scaffolding, not by `emit`, so counting it
      // would make every generator's tally one higher than the corpus it wrote.
      expect(summary.total).toBe(4);
      expect(summary.marker).toBe(GENERATED_WORKSPACE_MARKER);
   });

   it('normalises CRLF in emitted content to LF', () => {
      const root = scratchRoot('eol');

      makeGeneratedWorkspace({
         root,
         generator: 'probe',
         emit(writer) {
            writer.write('crlf.one', 'first\r\nsecond\r\n');
         }
      });

      // Without this the corpus is byte-identical only within one OS, so a
      // measurement taken on Windows cannot be read beside one taken on Linux.
      expect(readTree(root).get('crlf.one')).toBe('first\nsecond\n');
   });

   it('rejects a non-integer seed rather than silently producing an unreproducible corpus', () => {
      expect(() => makeGeneratedWorkspace({ root: scratchRoot('seed'), generator: 'probe', seed: 1.5, emit: emitSeeded(1) })).toThrow(
         /seed must be an integer/
      );
   });
});
