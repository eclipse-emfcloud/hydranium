/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGoldenCorpus } from '../../src/testing/node/golden-corpus.js';

describe('makeGoldenCorpus', () => {
   let directory: string;

   beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'hydranium-golden-'));
      // Deliberately written out of alphabetical order to prove sorting.
      writeFileSync(join(directory, 'second.x'), 'Element2 {\n}\n');
      writeFileSync(join(directory, 'first.x'), 'Element1 {\n}\n');
      // A different extension + a dotfile that must be filtered out.
      writeFileSync(join(directory, 'notes.txt'), 'ignore me');
      writeFileSync(join(directory, '.hidden.x'), 'Element {\n}\n');
   });

   afterAll(() => {
      rmSync(directory, { recursive: true, force: true });
   });

   it('returns fixtures matching the extension, sorted by file name', () => {
      const corpus = makeGoldenCorpus(directory, { extension: '.x' });
      expect(corpus.map(fixture => fixture.name)).toEqual(['.hidden', 'first', 'second']);
   });

   it('exposes name, fileName, absolute path and verbatim text per fixture', () => {
      const corpus = makeGoldenCorpus(directory, { extension: '.x' });
      const first = corpus.find(fixture => fixture.name === 'first')!;
      expect(first.fileName).toBe('first.x');
      expect(first.path).toBe(join(directory, 'first.x'));
      expect(first.text).toBe('Element1 {\n}\n');
   });

   it('filters out files that do not match the requested extension', () => {
      const corpus = makeGoldenCorpus(directory, { extension: '.x' });
      expect(corpus.some(fixture => fixture.fileName === 'notes.txt')).toBe(false);
   });

   it('includes every regular file when no extension filter is given', () => {
      const corpus = makeGoldenCorpus(directory);
      expect(corpus.map(fixture => fixture.fileName)).toContain('notes.txt');
   });

   describe('the empty-corpus guard', () => {
      let empty: string;

      beforeAll(() => {
         empty = mkdtempSync(join(tmpdir(), 'hydranium-golden-empty-'));
      });
      afterAll(() => {
         rmSync(empty, { recursive: true, force: true });
      });

      it('throws on an empty directory rather than returning an empty corpus', () => {
         // Returning `[]` is what makes a `describe.each` corpus suite register
         // zero tests and report green, so the primitive has to refuse.
         expect(() => makeGoldenCorpus(empty)).toThrow(/yielded 0 fixture\(s\)/);
      });

      it('throws when the extension filter matches nothing', () => {
         expect(() => makeGoldenCorpus(directory, { extension: '.nope' })).toThrow(/expected at least 1/);
      });

      it('throws when the corpus has shrunk below an explicit minimum', () => {
         expect(() => makeGoldenCorpus(directory, { extension: '.x', minimum: 4 })).toThrow(/yielded 3 fixture\(s\)/);
      });

      it('allows an empty corpus only when the minimum is explicitly zero', () => {
         expect(makeGoldenCorpus(empty, { minimum: 0 })).toEqual([]);
      });
   });
});
