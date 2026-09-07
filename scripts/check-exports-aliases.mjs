/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath-reachability gate: every `./x` entry in a package's `exports` map must
// have a `./lib/x` twin pointing at the same artefacts.
//
// Both spellings are load-bearing, because the two resolvers in this repo read
// DIFFERENT things and neither reads both:
//
//   - `moduleResolution: "Node"` (node10) — the `tsconfig.base.json` default,
//     and therefore what the Theia client packages and the host-agnostic example
//     clients compile under — IGNORES the `exports` map entirely and resolves
//     physically. It can reach `@hydranium/pkg/lib/x` and nothing else.
//   - vite/vitest and `moduleResolution: "NodeNext"` resolve THROUGH the map.
//     They can reach `@hydranium/pkg/x` and reject any path the map omits.
//
// So a subpath declared only as `./x` is reachable from a node10 consumer at
// compile time by no specifier at all: the bare form fails `tsc`, and the
// `/lib/` form fails at runtime with "is not exported under the conditions".
// Declaring both twins is what makes a subpath reachable from every consumer.
//
// The failure this prevents is quiet and misleading. It surfaces as "cannot find
// module" in a package that has the dependency correctly declared and installed,
// which reads as a broken install rather than as a missing two-line alias — and
// it is invisible until some consumer happens to compile under node10.
//
// The rule is ONE-DIRECTIONAL, which is why a `./lib/x` key needs no bare twin:
// that spelling already resolves under both resolvers, so a bare alias for it
// would only be a second name for one artefact.
//
// A package with NO map at all is the worst case rather than an exempt one, and
// this gate used to skip it — so the single package that most needed the check
// self-selected out of it. `files` ships a whole compiled tree, so a missing map
// makes every internal module deep-importable public surface that semver applies
// to on publish, and nothing reports it. A mapless manifest now FAILS.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(repoRoot, 'packages');

/** `./testing` -> `./lib/testing`. */
function aliasFor(key) {
   return `./lib/${key.slice('./'.length)}`;
}

/** Every path an `exports` value points at, flattening a conditions object. */
function targetPaths(value) {
   if (typeof value === 'string') {
      return [value];
   }
   if (value === null || typeof value !== 'object') {
      return [];
   }
   return Object.values(value).flatMap(targetPaths);
}

/**
 * Whether some `files` entry ships the artefact a `./x/y` target names.
 *
 * Deliberately conservative — first path segment against a whole `files` entry —
 * because the only judgement it has to make is "is this directory published at
 * all". A negation entry is ignored: those exclude build residue inside a
 * shipped directory, never the directory itself.
 */
function isShipped(manifest, target) {
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
function manifestProblems(manifest, packageRoot) {
   if (!manifest.exports) {
      return [
         'declares no `exports` map, so every emitted module — every internal helper, every command module — is deep-importable ' +
            'public surface that semver applies to on publish, and this gate can see none of it. Declare the surface, however small.'
      ];
   }

   const keys = Object.keys(manifest.exports);
   const problems = [];

   for (const key of keys) {
      if (key === '.' || key.startsWith('./lib/')) {
         continue;
      }

      const targets = targetPaths(manifest.exports[key]);
      const outsideLib = targets.filter(target => !target.startsWith('./lib/'));

      // An ASSET key points wholly outside `lib/`: `tsc` emits no assets, so
      // there is no compiled twin to pair with, and a bundler rather than a
      // module resolver is what reads it. Exempted from the twin rule and held
      // to the two mistakes an asset key can actually make instead. The carve-out
      // is self-limiting — any key reaching INTO `lib/` still needs its twin,
      // and a wildcard is refused outright so the exemption cannot be widened
      // into "everything is reachable and nothing is checkable".
      if (targets.length > 0 && outsideLib.length === targets.length) {
         for (const target of outsideLib) {
            if (target.includes('*')) {
               problems.push(
                  `"${key}" is a WILDCARD asset entry. Name the file: a wildcard makes every present and future file under it ` +
                     'reachable, and neither this gate nor a reader can bound what the key publishes.'
               );
            } else if (!existsSync(resolve(packageRoot, target))) {
               problems.push(`"${key}" points at "${target}", which does not exist.`);
            } else if (!isShipped(manifest, target)) {
               problems.push(
                  `"${key}" points at "${target}", which no \`files\` entry ships — it resolves from this tree and 404s from the tarball.`
               );
            }
         }
         continue;
      }

      const alias = aliasFor(key);
      if (!keys.includes(alias)) {
         problems.push(`"${key}" has no "${alias}" twin — unreachable from a node10 consumer.`);
         continue;
      }
      // A twin that points somewhere else is worse than a missing one: it
      // resolves, so nothing errors, and the two spellings of "the same"
      // subpath silently deliver different modules.
      if (JSON.stringify(manifest.exports[key]) !== JSON.stringify(manifest.exports[alias])) {
         problems.push(`"${key}" and "${alias}" resolve to DIFFERENT targets.`);
      }
   }

   return problems;
}

const styleRoot = resolve(packagesRoot, 'glsp-client-theia');

/**
 * Fixtures that MUST be rejected, plus one that must PASS.
 *
 * The repo is compliant today, so a clean run carries no information about
 * whether the rules still fire — and two of them are EXEMPTIONS (the `./lib/`
 * spelling, the asset carve-out), which is the shape that goes blind by
 * widening rather than by breaking. One canary per rule, and the positive one
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
      name: 'a bare subpath with no `./lib/` twin',
      root: repoRoot,
      manifest: { exports: { '.': './lib/index.js', './x': './lib/x/index.js' } },
      mustFail: true
   },
   {
      name: 'a twin aimed at a different target',
      root: repoRoot,
      manifest: { exports: { './x': './lib/x/index.js', './lib/x': './lib/other/index.js' } },
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
      name: 'a compliant map with a bare twin and a shipped asset',
      root: styleRoot,
      manifest: {
         files: ['lib', 'style'],
         exports: {
            '.': './lib/index.js',
            './x': './lib/x/index.js',
            './lib/x': './lib/x/index.js',
            './style/diagram-loading.css': './style/diagram-loading.css'
         }
      },
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
   const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
   const problems = manifestProblems(manifest, packageRoot);

   if (problems.length === 0) {
      console.log(`✓ ${manifest.name} — every subpath is reachable under both spellings`);
      continue;
   }

   failed = true;
   console.error(`✗ ${manifest.name} (packages/${packageDir}/package.json)`);
   for (const problem of problems) {
      console.error(`    ${problem}`);
   }
}

if (failed) {
   console.error('\nSubpath-reachability gate failed: give each "./x" entry a "./lib/x" twin with the same target.');
   console.error('(A SELF-TEST failure means the opposite — the gate stopped discriminating, so fix the gate.)');
   process.exit(1);
}
console.log('\nAll package subpaths are reachable under both the bare and the `/lib/` spelling.');
