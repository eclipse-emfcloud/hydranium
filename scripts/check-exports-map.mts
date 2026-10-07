/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Exports-map gate: every package declares an `exports` map, and each artefact
// in it has one public name. A second key for the same targets is a second
// specifier semver applies to, and the two can drift apart with nothing erroring.
//
// A package with no map fails: `files` ships a whole compiled tree, so a missing
// map makes every internal module deep-importable public surface on publish, and
// no resolution ever fails to report it.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExports } from './exports-map.mts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(repoRoot, 'packages');

interface Manifest {
   name?: string;
   files?: string[];
   exports?: unknown;
}

/**
 * Whether some `files` entry ships the artefact a `./x/y` target names.
 *
 * Deliberately conservative — first path segment against a whole `files` entry —
 * because the only judgement it has to make is "is this directory published at
 * all". A negation entry is ignored: those exclude build residue inside a
 * shipped directory, never the directory itself.
 */
function isShipped(manifest: Manifest, target: string): boolean {
   const [firstSegment] = target.replace(/^\.\//, '').split('/');
   return (manifest.files ?? []).some(entry => !entry.startsWith('!') && entry.replace(/^\.\//, '').replace(/\/$/, '') === firstSegment);
}

/**
 * Everything wrong with one manifest's `exports` map, as reportable lines.
 *
 * Pure apart from `existsSync` under `packageRoot`, so the self-test below can
 * put synthetic manifests through the same code the real walk uses — a second
 * implementation for the canaries would be free to agree with nothing.
 */
function manifestProblems(manifest: Manifest, packageRoot: string): string[] {
   if (!manifest.exports) {
      return [
         'declares no `exports` map, so every emitted module — every internal helper, every command module — is deep-importable ' +
            'public surface that semver applies to on publish, and this gate can see none of it. Declare the surface, however small.'
      ];
   }

   const problems: string[] = [];
   const keyByTargets = new Map<string, string>();

   for (const { key, runtimePaths, typePaths } of readExports(manifest.exports)) {
      // A wildcard target escapes the collision check below, since it never
      // equals one declared file. A `null` wildcard blocks paths and stays legal.
      const paths = [...runtimePaths, ...typePaths];
      if (paths.some(target => target.includes('*'))) {
         problems.push(
            `"${key}" is a WILDCARD entry. Name each subpath: a wildcard makes every present and future file under it ` +
               'reachable, second names for the declared subpaths included, and neither this gate nor a reader can bound what it publishes.'
         );
         continue;
      }

      // Compared by the files a key loads at runtime, so an alias spelling its
      // conditions in another order or shape still collides. A key loading
      // nothing, such as a `null` that blocks a subpath, names no artefact.
      if (runtimePaths.length > 0) {
         const targets = JSON.stringify(runtimePaths);
         const namedBefore = keyByTargets.get(targets);
         if (namedBefore) {
            problems.push(`"${key}" resolves to the same targets as "${namedBefore}" — one artefact, two public names.`);
         } else {
            keyByTargets.set(targets, key);
         }
      }

      // An asset key points wholly outside `lib/`, so no build step produces its
      // target.
      if (paths.length > 0 && paths.every(target => !target.startsWith('./lib/'))) {
         for (const target of paths) {
            if (!existsSync(resolve(packageRoot, target))) {
               problems.push(`"${key}" points at "${target}", which does not exist.`);
            } else if (!isShipped(manifest, target)) {
               problems.push(
                  `"${key}" points at "${target}", which no \`files\` entry ships — it resolves from this tree and 404s from the tarball.`
               );
            }
         }
      }
   }

   return problems;
}

const styleRoot = resolve(packagesRoot, 'glsp-client-theia');

/**
 * Fixtures that MUST be rejected, plus one that must PASS.
 *
 * The repo is compliant today, so a clean run carries no information about
 * whether the rules still fire. One canary per rule, and the positive one
 * because a rule that rejects everything passes every negative canary.
 */
const SELF_TESTS = [
   {
      name: 'a manifest with no `exports` map',
      root: repoRoot,
      manifest: { files: ['lib'] },
      mustFail: true
   },
   {
      name: 'a `./lib/` alias of a bare subpath',
      root: repoRoot,
      manifest: { exports: { '.': './lib/index.js', './x': './lib/x/index.js', './lib/x': './lib/x/index.js' } },
      mustFail: true
   },
   {
      name: 'an alias declaring its conditions in another order',
      root: repoRoot,
      manifest: {
         exports: {
            './x': { types: './lib/x/index.d.ts', default: './lib/x/index.js' },
            './lib/x': { default: './lib/x/index.js', types: './lib/x/index.d.ts' }
         }
      },
      mustFail: true
   },
   {
      name: 'a wildcard module key aliasing every bare subpath',
      root: repoRoot,
      manifest: { exports: { '.': './lib/index.js', './x': './lib/x/index.js', './lib/*': './lib/*.js' } },
      mustFail: true
   },
   {
      name: 'an alias of a key naming one file under two conditions',
      root: repoRoot,
      manifest: { exports: { './x': { import: './lib/x/index.js', default: './lib/x/index.js' }, './lib/x': './lib/x/index.js' } },
      mustFail: true
   },
   {
      name: 'an alias declaring a bare string beside a conditions object',
      root: repoRoot,
      manifest: { exports: { './x': './lib/x/index.js', './lib/x': { types: './lib/x/index.d.ts', default: './lib/x/index.js' } } },
      mustFail: true
   },
   {
      name: 'an asset entry naming a file that does not exist',
      root: styleRoot,
      manifest: { files: ['style'], exports: { './style/gone.css': './style/gone.css' } },
      mustFail: true
   },
   {
      name: 'an asset entry no `files` entry ships',
      root: styleRoot,
      manifest: { files: ['lib'], exports: { './style/diagram-loading.css': './style/diagram-loading.css' } },
      mustFail: true
   },
   {
      name: 'a wildcard asset entry',
      root: styleRoot,
      manifest: { files: ['style'], exports: { './style/*': './style/*' } },
      mustFail: true
   },
   {
      name: 'a compliant map with a bare subpath, a file key and a shipped asset',
      root: styleRoot,
      manifest: {
         files: ['lib', 'style'],
         exports: {
            '.': './lib/index.js',
            './x': './lib/x/index.js',
            './lib/cli.js': './lib/cli.js',
            './style/diagram-loading.css': './style/diagram-loading.css'
         }
      },
      mustFail: false
   },
   {
      name: 'a map blocking two subpaths with null',
      root: repoRoot,
      manifest: { exports: { '.': './lib/index.js', './internal/*': null, './lib/*': null } },
      mustFail: false
   }
];

let failed = false;

for (const selfTest of SELF_TESTS) {
   const problems = manifestProblems(selfTest.manifest, selfTest.root);
   if (selfTest.mustFail && problems.length === 0) {
      failed = true;
      console.error(`✗ SELF-TEST FAILED: ${selfTest.name} was NOT rejected — this gate has gone blind`);
   } else if (!selfTest.mustFail && problems.length > 0) {
      failed = true;
      console.error(`✗ SELF-TEST FAILED: ${selfTest.name} was rejected — this gate now refuses compliant maps`);
      for (const problem of problems) {
         console.error(`    ${problem}`);
      }
   } else {
      console.log(`✓ self-test: ${selfTest.name} ${selfTest.mustFail ? 'rejected' : 'accepted'} as it must be`);
   }
}
console.log('');

for (const packageDir of readdirSync(packagesRoot).sort()) {
   const packageRoot = resolve(packagesRoot, packageDir);
   const manifestPath = resolve(packageRoot, 'package.json');
   if (!existsSync(manifestPath)) {
      continue;
   }
   const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
   const problems = manifestProblems(manifest, packageRoot);

   if (problems.length === 0) {
      console.log(`✓ ${manifest.name} — one name per artefact`);
      continue;
   }

   failed = true;
   console.error(`✗ ${manifest.name} (packages/${packageDir}/package.json)`);
   for (const problem of problems) {
      console.error(`    ${problem}`);
   }
}

if (failed) {
   console.error('\nExports-map gate failed: declare a map, and give each artefact one key.');
   console.error('(A SELF-TEST failure means the gate stopped discriminating, so fix the gate.)');
   process.exit(1);
}
console.log('\nEvery package declares an exports map with one name per artefact.');
