/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Workspace detection for `init --monorepo`.
 *
 * Split from `init.ts` because the rules here are the only part of `init` that
 * reads files it does not write, and because the reliable/unreliable line runs
 * straight through them: the root and the base tsconfig are *detected*, the
 * package scope is *guessed from siblings* and the `private` flag is not
 * derivable at all. Keeping them in one module makes that distinction reviewable
 * rather than scattered across the scaffolder.
 *
 * Everything is expressed over {@link WorkspaceProbe} rather than `node:fs`, so
 * the rules are testable against an in-memory tree instead of a temp directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** A JSON value as `JSON.parse` produces it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** True for a JSON object — the shape `package.json` and `tsconfig.json` parse to. */
function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The filesystem reads detection needs, injectable so the rules are unit-testable. */
export interface WorkspaceProbe {
   /** Parse a JSON file, or `undefined` when it is missing or unparseable. */
   readonly readJson: (absolutePath: string) => JsonValue | undefined;
   /** Names of the subdirectories of `absolutePath`; empty when it is not a directory. */
   readonly listDirectories: (absolutePath: string) => readonly string[];
   /** Names of the files directly in `absolutePath`; empty when it is not a directory. */
   readonly listFiles: (absolutePath: string) => readonly string[];
   /**
    * Raw contents of a file, or `undefined` when it is missing or unreadable.
    *
    * Separate from {@link readJson} because the two configs read through it —
    * prettier's and eslint's — are routinely JavaScript modules, which no JSON
    * parser can reach. Required rather than optional so a test double cannot
    * omit it and silently degrade every detection built on it to "not found".
    */
   readonly readText: (absolutePath: string) => string | undefined;
}

/**
 * Strip the two things `tsc` accepts in a config that `JSON.parse` rejects:
 * comments, and a trailing comma before a closing brace or bracket.
 *
 * Written as a scanner rather than a regex because both constructs are legal
 * INSIDE a string — `"https://example.com"` holds a `//`, and a description can
 * end in a comma — so a pattern that ignores string state corrupts the very
 * configs it is meant to rescue. Without this, a base config with a single
 * comment reads as "no compilerOptions here" and the scaffold silently emits no
 * `extends` at all, which is the worst failure shape available: quietly wrong
 * rather than loudly broken.
 */
export function stripJsonComments(text: string): string {
   const characters = [...text];
   const output: string[] = [];
   const commaIndices: number[] = [];
   let inString = false;
   let escaped = false;
   for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      const next = characters[index + 1];
      if (inString) {
         output.push(character);
         if (escaped) {
            escaped = false;
         } else if (character === '\\') {
            escaped = true;
         } else if (character === '"') {
            inString = false;
         }
         continue;
      }
      if (character === '"') {
         inString = true;
         output.push(character);
         continue;
      }
      if (character === '/' && next === '/') {
         while (index < characters.length && characters[index] !== '\n') {
            index += 1;
         }
         output.push('\n');
         continue;
      }
      if (character === '/' && next === '*') {
         index += 2;
         while (index < characters.length && !(characters[index] === '*' && characters[index + 1] === '/')) {
            index += 1;
         }
         index += 1;
         continue;
      }
      if (character === ',') {
         commaIndices.push(output.length);
      }
      output.push(character);
   }
   // A comma is trailing only if the next thing that is not whitespace closes
   // the object or array. Resolved after the scan, so the lookahead sees text
   // with the comments already gone.
   for (const commaIndex of commaIndices) {
      let lookahead = commaIndex + 1;
      while (lookahead < output.length && /\s/.test(output[lookahead])) {
         lookahead += 1;
      }
      if (output[lookahead] === '}' || output[lookahead] === ']') {
         output[commaIndex] = '';
      }
   }
   return output.join('');
}

/**
 * The real-filesystem probe.
 *
 * Every read is best-effort: detection runs over directories the user may not
 * own, so an unreadable or malformed file degrades to "not found" rather than
 * aborting a scaffold.
 */
export function createNodeWorkspaceProbe(): WorkspaceProbe {
   const listEntries = (absolutePath: string, wantDirectory: boolean): string[] => {
      try {
         return fs
            .readdirSync(absolutePath, { withFileTypes: true })
            .filter(entry => entry.isDirectory() === wantDirectory)
            .map(entry => entry.name);
      } catch {
         return [];
      }
   };
   return {
      readJson: absolutePath => {
         try {
            return JSON.parse(stripJsonComments(fs.readFileSync(absolutePath, 'utf-8'))) as JsonValue;
         } catch {
            return undefined;
         }
      },
      listDirectories: absolutePath => listEntries(absolutePath, true),
      listFiles: absolutePath => listEntries(absolutePath, false),
      readText: absolutePath => {
         try {
            return fs.readFileSync(absolutePath, 'utf-8');
         } catch {
            return undefined;
         }
      }
   };
}

/** What {@link detectWorkspace} found around a target directory. */
export interface WorkspaceDetection {
   /** Absolute path of the directory whose `package.json` declares `workspaces`. */
   readonly rootDir: string;
   /** The root's `workspaces` globs, verbatim. */
   readonly workspaces: readonly string[];
   /** POSIX path of the target relative to {@link rootDir}, e.g. `packages/foo`. */
   readonly targetPath: string;
   /**
    * The `workspaces` glob already covering {@link targetPath}, if any.
    *
    * Absent means the root manifest needs a new entry — which is why this is
    * computed per target rather than assumed: a `packages/*` glob covers a new
    * package for free, while a repo that lists its examples one by one does not.
    */
   readonly coveredBy?: string;
   /** The npm scope the sibling packages agree on (`@acme`), when they agree. */
   readonly scope?: string;
   /**
    * Relative specifier of the tsconfig carrying `compilerOptions`, e.g.
    * `../../tsconfig.base.json`. Absent when the root has none.
    */
   readonly baseTsconfig?: string;
   /** That tsconfig's `compilerOptions`, so the emitted one can drop what it inherits. */
   readonly baseCompilerOptions?: Readonly<Record<string, JsonValue>>;
   /** The root prettier config's `printWidth`, so emitted sources wrap where the repo wraps. */
   readonly printWidth?: number;
   /** Filename of the root eslint config, when there is one. Absent means the repo does not lint. */
   readonly eslintConfig?: string;
}

/**
 * The nearest ancestor of `targetDir` whose `package.json` declares
 * `workspaces`.
 *
 * Nearest rather than outermost: nested workspaces are legal, and the inner one
 * is the manifest that would actually claim the new package.
 */
export function findWorkspaceRoot(targetDir: string, probe: WorkspaceProbe): string | undefined {
   let current = path.resolve(targetDir);
   for (;;) {
      const manifest = probe.readJson(path.join(current, 'package.json'));
      if (isJsonObject(manifest) && Array.isArray(manifest.workspaces)) {
         return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
         return undefined;
      }
      current = parent;
   }
}

/** The `workspaces` globs of a detected root, as strings. */
function readWorkspaces(rootDir: string, probe: WorkspaceProbe): string[] {
   const manifest = probe.readJson(path.join(rootDir, 'package.json'));
   if (!isJsonObject(manifest) || !Array.isArray(manifest.workspaces)) {
      return [];
   }
   return manifest.workspaces.filter((entry): entry is string => typeof entry === 'string');
}

/** Match one path segment against a glob segment, where `*` stands for "any run of non-separator". */
function segmentMatches(glob: string, segment: string): boolean {
   const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
   return new RegExp(`^${source}$`).test(segment);
}

/**
 * True when a `workspaces` glob covers a repo-relative path.
 *
 * `**` is treated as covering any run of segments. Deliberately no glob
 * dependency: npm's own set is small, and a wrong answer here only costs a
 * printed hint that turns out to be unnecessary.
 */
export function workspaceGlobCovers(glob: string, relativePath: string): boolean {
   const globSegments = glob.split('/').filter(segment => segment.length > 0);
   const pathSegments = relativePath.split('/').filter(segment => segment.length > 0);
   const matches = (globIndex: number, pathIndex: number): boolean => {
      if (globIndex === globSegments.length) {
         return pathIndex === pathSegments.length;
      }
      if (globSegments[globIndex] === '**') {
         for (let skip = pathIndex; skip <= pathSegments.length; skip += 1) {
            if (matches(globIndex + 1, skip)) {
               return true;
            }
         }
         return false;
      }
      return (
         pathIndex < pathSegments.length &&
         segmentMatches(globSegments[globIndex], pathSegments[pathIndex]) &&
         matches(globIndex + 1, pathIndex + 1)
      );
   };
   return matches(0, 0);
}

/**
 * Expand a `workspaces` glob to the directories it currently names.
 *
 * `**` is not expanded — it returns nothing rather than walking an unbounded
 * tree, because the only caller is scope inference, which a partial sample
 * answers just as well.
 */
function expandWorkspaceGlob(rootDir: string, glob: string, probe: WorkspaceProbe): string[] {
   const segments = glob.split('/').filter(segment => segment.length > 0);
   let directories = [rootDir];
   for (const segment of segments) {
      if (segment === '**') {
         return [];
      }
      if (!segment.includes('*')) {
         directories = directories.map(directory => path.join(directory, segment));
         continue;
      }
      directories = directories.flatMap(directory =>
         probe
            .listDirectories(directory)
            .filter(name => segmentMatches(segment, name))
            .map(name => path.join(directory, name))
      );
   }
   return directories;
}

/**
 * The npm scope the existing workspace members agree on.
 *
 * Guessed from siblings and NOT from the root manifest, which in a framework
 * repo is routinely named for the repo rather than the scope it publishes under
 * — so reading it would confidently produce the wrong answer. Requires a
 * unanimous scope: a split verdict is exactly the case where a prompt should
 * ask rather than a heuristic should pick.
 */
export function inferPackageScope(rootDir: string, workspaces: readonly string[], probe: WorkspaceProbe): string | undefined {
   const scopes = new Set<string>();
   for (const glob of workspaces) {
      for (const directory of expandWorkspaceGlob(rootDir, glob, probe)) {
         const manifest = probe.readJson(path.join(directory, 'package.json'));
         if (!isJsonObject(manifest) || typeof manifest.name !== 'string') {
            continue;
         }
         const scope = manifest.name.startsWith('@') ? manifest.name.split('/')[0] : '';
         scopes.add(scope);
      }
   }
   scopes.delete('');
   return scopes.size === 1 ? [...scopes][0] : undefined;
}

/**
 * The root tsconfig that actually carries `compilerOptions`.
 *
 * `tsconfig.json` at a monorepo root is very often a *solution* file — `files:
 * []` plus `references` — so extending it inherits nothing and silently drops
 * every compiler setting the package meant to pick up. Hence the search is by
 * content, preferring the conventional `tsconfig.base.json` name only as a
 * tie-break, never as the test.
 */
export function findBaseTsconfig(
   rootDir: string,
   probe: WorkspaceProbe
): { readonly file: string; readonly compilerOptions: Readonly<Record<string, JsonValue>> } | undefined {
   const present = probe.listFiles(rootDir).filter(name => /^tsconfig(\..+)?\.json$/.test(name));
   const preferred = ['tsconfig.base.json', 'tsconfig.json'];
   const candidates = [...preferred.filter(name => present.includes(name)), ...present.filter(name => !preferred.includes(name)).sort()];
   for (const file of candidates) {
      const parsed = probe.readJson(path.join(rootDir, file));
      if (isJsonObject(parsed) && isJsonObject(parsed.compilerOptions) && Object.keys(parsed.compilerOptions).length > 0) {
         return { file, compilerOptions: parsed.compilerOptions };
      }
   }
   return undefined;
}

/**
 * The repo's prettier `printWidth`, so the emitted sources wrap where the repo
 * wraps instead of at the scaffold's own default.
 *
 * **Why this is worth detecting at all.** There is no width that is stable for
 * an unknown repo — 80 (prettier's own default), 100, 120 and 140 each produce
 * different wrapping — so emitted code that "passes a formatter check as-is" is
 * only ever true relative to a config. Matching the one we can see is the
 * closest thing available.
 *
 * **A regex over the file, deliberately, and only for the module forms.** The
 * JSON forms are parsed properly; `.prettierrc.js` and `prettier.config.mjs` are
 * executable modules that no scaffold should evaluate, and skipping them would
 * miss the configs most repos actually use. The pattern takes the FIRST
 * `printWidth`, which is the top-level one in every config laid out
 * conventionally — an `overrides` entry appearing before it would win, and that
 * is the known limit.
 *
 * Getting it wrong costs exactly what getting it absent costs today: the
 * adopter's formatter rewraps on first commit. So a heuristic that is usually
 * right strictly improves on no detection, and can break nothing.
 */
export function findPrettierPrintWidth(rootDir: string, probe: WorkspaceProbe): number | undefined {
   const manifest = probe.readJson(path.join(rootDir, 'package.json'));
   if (isJsonObject(manifest) && isJsonObject(manifest.prettier) && typeof manifest.prettier.printWidth === 'number') {
      return manifest.prettier.printWidth;
   }
   const present = probe.listFiles(rootDir);
   for (const file of present.filter(name => name === '.prettierrc' || name === '.prettierrc.json')) {
      const parsed = probe.readJson(path.join(rootDir, file));
      if (isJsonObject(parsed) && typeof parsed.printWidth === 'number') {
         return parsed.printWidth;
      }
   }
   for (const file of present.filter(name => /^(\.prettierrc\.[cm]?[jt]s|prettier\.config\.[cm]?[jt]s)$/.test(name))) {
      const width = /\bprintWidth\s*:\s*(\d+)/.exec(probe.readText(path.join(rootDir, file)) ?? '');
      if (width) {
         return Number(width[1]);
      }
   }
   return undefined;
}

/**
 * The root eslint config's filename, when the repo has one.
 *
 * Read to decide whether the scaffold emits a `lint` script. The failure it
 * prevents is silent in the direction that matters: a task runner runs a script
 * only where one is declared, so a package without `lint` is SKIPPED rather than
 * reported, and the absence reads as a clean lint. Emitting the script into a
 * repo whose lint invocation differs costs one visible line to edit.
 *
 * Both config generations, because detecting a repo that has not migrated off
 * `.eslintrc` is free and the question asked here — does this repo lint? — is
 * the same either way.
 */
export function findEslintConfig(rootDir: string, probe: WorkspaceProbe): string | undefined {
   return probe.listFiles(rootDir).find(name => /^eslint\.config\.[cm]?[jt]s$/.test(name) || /^\.eslintrc(\..+)?$/.test(name));
}

/** POSIX-style relative path, which is what both `extends` and `--prefix` want on every platform. */
function posixRelative(from: string, to: string): string {
   return path.relative(from, to).split(path.sep).join('/');
}

/**
 * Detect the workspace `targetDir` would join. `undefined` when no ancestor
 * declares `workspaces`, which is the standalone case and not an error here —
 * `runInit` decides whether that is fatal.
 *
 * The target is resolved against the process's working directory, so a relative
 * one is relative to where the command was RUN, not to anything the scaffolder
 * picks. That matters because the two are routinely different directories.
 */
export function detectWorkspace(targetDir: string, probe: WorkspaceProbe): WorkspaceDetection | undefined {
   const absoluteTarget = path.resolve(targetDir);
   const rootDir = findWorkspaceRoot(absoluteTarget, probe);
   if (rootDir === undefined) {
      return undefined;
   }
   const workspaces = readWorkspaces(rootDir, probe);
   const targetPath = posixRelative(rootDir, absoluteTarget);
   // The target IS the workspace root — `init .` at the top of a monorepo, or a
   // target that resolved to the cwd because it was empty. There is no member to
   // place, so reporting a placement here describes a scaffold that cannot
   // happen and names a directory the user never asked for.
   if (targetPath === '') {
      return undefined;
   }
   const base = findBaseTsconfig(rootDir, probe);
   return {
      rootDir,
      workspaces,
      targetPath,
      coveredBy: workspaces.find(glob => workspaceGlobCovers(glob, targetPath)),
      scope: inferPackageScope(rootDir, workspaces, probe),
      baseTsconfig: base && posixRelative(absoluteTarget, path.join(rootDir, base.file)),
      baseCompilerOptions: base?.compilerOptions,
      printWidth: findPrettierPrintWidth(rootDir, probe),
      eslintConfig: findEslintConfig(rootDir, probe)
   };
}
