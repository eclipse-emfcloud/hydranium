/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Golden-file testing for grammar serializers.
 *
 * # The idea
 *
 * A *golden file* holds the exact expected output of some process, committed
 * to the repo as the source of truth. The test runs the process and compares
 * its output against the golden byte-for-byte; a mismatch fails and shows a
 * readable diff. A *golden corpus* is just a directory of such files — one
 * per case — spanning the matrix of inputs worth pinning.
 *
 * Here the process under test is a grammar serializer (AST → source text).
 * Each golden is a source file written in the serializer's canonical output
 * format; the corpus test parses it, re-serializes, and asserts the result
 * reproduces the file exactly. So any change to the serializer's *formatting*
 * — an indent width, a clause order, a stray trailing space — stops
 * reproducing the goldens and surfaces as a concrete, reviewable diff instead
 * of a silent behavioural drift.
 *
 * # Why files, not runner snapshots
 *
 * The artifact under test IS an output *format*, so it belongs in a real,
 * diffable, hand-authored file. A runner's `.snap` snapshot is runner-
 * specific, and its `-u` "update" flag rubber-stamps whatever the code now
 * emits — exactly the regression a golden test exists to catch. A committed
 * golden makes an update a deliberate edit that a reviewer sees.
 *
 * # Division of labour
 *
 * This module is the framework-side *mechanism* — discover + read files —
 * and is grammar-agnostic. The *content* (the goldens themselves and the
 * parse/serialize wiring) is adopter-side, because a serializer's output is
 * always specific to its grammar. Pair {@link makeGoldenCorpus} with
 * `makeAstSnapshot` for the structural round-trip half of the corpus.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/** One committed golden fixture: a source file whose serialized form is under test. */
export interface GoldenFixture {
   /** File name with the matched extension stripped — the `$name` for `it.each`/`describe.each`. */
   readonly name: string;
   /** Full file name including extension. */
   readonly fileName: string;
   /** Absolute path to the fixture on disk. */
   readonly path: string;
   /** Verbatim file contents (UTF-8), including any trailing newline. */
   readonly text: string;
}

export interface MakeGoldenCorpusOptions {
   /**
    * Only include files ending with this extension, leading dot included. Omit
    * to include every regular file in the directory. The extension is stripped
    * from {@link GoldenFixture.name}.
    */
   readonly extension?: string;
   /**
    * Fewest fixtures the corpus must yield; below it {@link makeGoldenCorpus}
    * throws. Default `1`.
    *
    * `describe.each([])` registers zero tests and reports a green suite, so an
    * empty corpus passes as coverage — the throw is what makes it observable.
    * `0` opts out, for a caller that treats an empty directory as valid.
    */
   readonly minimum?: number;
}

/**
 * Read a directory of committed golden fixtures into a deterministic,
 * name-sorted list a runner can drive with `it.each`/`describe.each`. See the
 * module comment for the golden-file mechanism this implements. The corpus is
 * discovered here; the grammar-specific `parse`/`serialize` the byte-stability
 * assertion needs are supplied adopter-side.
 *
 * Reads synchronously so the corpus is available at test-collection time
 * (when `it.each` expands). Sub-directories are ignored — a flat corpus keeps
 * the `$name` labels unambiguous. Throws below
 * {@link MakeGoldenCorpusOptions.minimum}.
 */
export function makeGoldenCorpus(directory: string, options: MakeGoldenCorpusOptions = {}): GoldenFixture[] {
   const { extension, minimum = 1 } = options;
   const fixtures = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .filter(entry => extension === undefined || entry.name.endsWith(extension))
      .map(entry => {
         const path = join(directory, entry.name);
         return {
            name: extension === undefined ? entry.name : basename(entry.name, extension),
            fileName: entry.name,
            path,
            text: readFileSync(path, 'utf8')
         };
      })
      .sort((left, right) => (left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0));
   if (fixtures.length < minimum) {
      const filter = extension === undefined ? 'no extension filter' : `extension '${extension}'`;
      throw new Error(
         `golden corpus at ${directory} yielded ${fixtures.length} fixture(s) with ${filter}, expected at least ${minimum}. ` +
            'An empty corpus makes `describe.each` register zero tests, so the suite would pass without asserting anything.'
      );
   }
   return fixtures;
}
