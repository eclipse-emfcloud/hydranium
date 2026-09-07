/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Scaffolding for a generated on-disk corpus: the seeded PRNG, the
 * overwrite permit, the newline normalisation and the per-extension tally.
 * The caller supplies only the content.
 *
 * # Why the corpus is generated rather than committed
 *
 * A volume fixture is what a profiling run, a `watch` claim and any
 * incremental-rebuild claim measure against, and it is several hundred files.
 * Committing a deterministic generator and gitignoring its output keeps the
 * artefact reproducible by any contributor at a fixed seed without the
 * repository carrying the files.
 *
 * # Determinism is the whole contract, and it is fragile
 *
 * A performance figure is only readable beside another figure taken over the
 * same input, so "same parameters, same bytes" is not a nicety. Three things
 * break it and all three are handled here rather than left to each generator:
 * `Math.random` (hence {@link GeneratedWorkspaceWriter.random}, a seeded
 * mulberry32), a timestamp anywhere in the output (hence nothing written here
 * records one), and platform line endings (hence
 * {@link GeneratedWorkspaceWriter.write} normalising to LF).
 *
 * The draw order is the caller's responsibility, and it is the one that catches
 * people out: the PRNG is a single stream, so a generator that reorders its
 * emission — or draws conditionally on something it did not draw before —
 * produces a different corpus at the same seed.
 *
 * # Size is a parameter because the signal is a CURVE
 *
 * An O(n²) regression in discovery, indexing, scope or linking is invisible in
 * a single measurement: it shows up as the large/small ratio outrunning the
 * file-count ratio. That is why this is a callable module rather than only a
 * script — a bench runs it in-process at two sizes instead of shelling out —
 * and why a generator built on it should take its sizes as options rather than
 * fixing one N.
 *
 * # The marker is a permit, not a label
 *
 * Generating wipes the target directory, the caller names that directory, and
 * the default is typically inside the repository. So the wipe needs
 * authorisation: an absent directory, an empty one, or one already carrying the
 * marker file. Anything else throws rather than deleting a tree this generator
 * did not write.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** Default name of the file that records — and authorises — a generated corpus. */
export const GENERATED_WORKSPACE_MARKER = '.hydranium-generated-workspace';

/** The write surface {@link makeGeneratedWorkspace} hands to {@link GeneratedWorkspaceOptions.emit}. */
export interface GeneratedWorkspaceWriter {
   /** Absolute, resolved path of the corpus root. Already created and empty. */
   readonly root: string;
   /**
    * Next value of the seeded stream, in `[0, 1)`.
    *
    * One stream for the whole corpus, drawn in emission order — so this is
    * reproducible only as long as the emission order is. Prefer drawing
    * unconditionally over drawing inside a branch.
    */
   random(): number;
   /** An integer in `[minimum, maximum]`, both inclusive, off the same stream. */
   randomInt(minimum: number, maximum: number): number;
   /**
    * Write `content` at `relativePath` under {@link root}, creating parent
    * directories, and count it in the summary's tally. Returns the absolute
    * path.
    *
    * Line endings are normalised to LF, without which the corpus is not
    * byte-identical across platforms and the determinism contract holds only on
    * one OS.
    */
   write(relativePath: string, content: string): string;
   /** Create a directory under {@link root} and return its absolute path. */
   directory(relativePath: string): string;
}

/** Inputs to {@link makeGeneratedWorkspace}. */
export interface GeneratedWorkspaceOptions {
   /** Directory to write into. Created if absent; wiped if the marker permits it. */
   readonly root: string;
   /**
    * Identifies the generator in the marker file, so a corpus found on disk
    * says what produced it. Free-form; a package-qualified name reads best.
    */
   readonly generator: string;
   /**
    * Recorded in the marker alongside the seed — the sizes the corpus was
    * generated at, which is what makes a measurement taken over it
    * interpretable later.
    */
   readonly parameters?: Readonly<Record<string, number | string | boolean>>;
   /** Seed for the content stream. Defaults to `0`; the same seed reproduces the corpus byte for byte. */
   readonly seed?: number;
   /** Marker file name. Defaults to {@link GENERATED_WORKSPACE_MARKER}. */
   readonly marker?: string;
   /** Emit the content. Called once, after the root is prepared and the marker written. */
   emit(writer: GeneratedWorkspaceWriter): void;
}

/** What {@link makeGeneratedWorkspace} wrote. */
export interface GeneratedWorkspaceSummary {
   /** Absolute, resolved corpus root. */
   readonly root: string;
   /** Seed actually used, after the default. */
   readonly seed: number;
   /** Marker file name actually used, relative to {@link root}. */
   readonly marker: string;
   /**
    * How many files `emit` wrote, keyed by extension WITH the leading dot
    * (`'.domain'`). The marker is not counted; everything `emit` wrote is,
    * including any README, so a caller wanting a model-file subtotal adds up
    * the extensions it considers model files.
    *
    * A tally is worth returning rather than leaving to the caller because it is
    * the cheap assertion that catches the expensive defect: a generator whose
    * nested loops skip a file still reports the size it was asked for, and the
    * corpus is then quietly smaller than the number a measurement is filed
    * under. Read it against a count taken off the filesystem, not instead of
    * one — this counts the calls, so it cannot see a failed write.
    */
   readonly files: Readonly<Record<string, number>>;
   /** Total files `emit` wrote, the marker excluded. */
   readonly total: number;
}

/**
 * A deterministic 32-bit PRNG (mulberry32). Deliberately not `Math.random`: a
 * corpus that varies per run cannot carry a comparable measurement.
 */
function makeRandom(seed: number): () => number {
   let state = seed >>> 0;
   return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
   };
}

/**
 * Prepare `root` for a fresh corpus, or throw naming the marker that would
 * have authorised the wipe.
 */
function prepareRoot(root: string, marker: string): void {
   if (existsSync(root)) {
      const entries = readdirSync(root);
      if (entries.length > 0 && !entries.includes(marker)) {
         throw new Error(
            `Refusing to overwrite ${root}: it is not empty and carries no ${marker} marker. ` +
               'Point the output at a fresh directory, or delete this one yourself.'
         );
      }
      rmSync(root, { recursive: true, force: true });
   }
   mkdirSync(root, { recursive: true });
}

/**
 * Generate a corpus under `options.root` and return what was written.
 *
 * The marker is written BEFORE `emit` runs, so an emission that throws
 * half-way leaves a directory the next run is still permitted to wipe. Writing
 * it afterwards would strand a partial corpus that has to be deleted by hand,
 * and it buys nothing: the marker only ever lands in a directory this function
 * has just created or been authorised to clear.
 */
export function makeGeneratedWorkspace(options: GeneratedWorkspaceOptions): GeneratedWorkspaceSummary {
   const root = path.resolve(options.root);
   const marker = options.marker ?? GENERATED_WORKSPACE_MARKER;
   const seed = options.seed ?? 0;
   if (!Number.isInteger(seed)) {
      throw new Error(`seed must be an integer, got ${String(seed)}`);
   }
   prepareRoot(root, marker);

   const random = makeRandom(seed);
   const files: Record<string, number> = {};
   let total = 0;
   const writeFile = (target: string, content: string): void => {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content.replace(/\r\n/g, '\n'), 'utf8');
   };

   // Nothing here records a timestamp, which is the other half of the
   // byte-reproducibility property the seeded stream gives.
   writeFile(path.join(root, marker), `${JSON.stringify({ generator: options.generator, seed, ...options.parameters }, undefined, 2)}\n`);

   options.emit({
      root,
      random,
      randomInt: (minimum, maximum) => minimum + Math.floor(random() * (maximum - minimum + 1)),
      write(relativePath, content) {
         const target = path.join(root, relativePath);
         writeFile(target, content);
         const extension = path.extname(relativePath);
         files[extension] = (files[extension] ?? 0) + 1;
         total += 1;
         return target;
      },
      directory(relativePath) {
         const target = path.join(root, relativePath);
         mkdirSync(target, { recursive: true });
         return target;
      }
   });

   return { root, seed, marker, files, total };
}
