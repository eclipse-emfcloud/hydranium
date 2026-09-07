#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Per-package LICENSE gate.
 *
 * Every PUBLISHED package must carry its own copy of the root `LICENSE`. The
 * root file lives outside each package directory, so it is absent from every
 * tarball — which would leave installers with the `license` field and the SPDX
 * headers but no copy of the MIT permission notice MIT itself requires
 * ("shall be included in all copies or substantial portions"). It would also
 * break the header text, which promises the license is "available in the
 * project root": in an installed package, that root IS the package root.
 *
 * npm always ships a `LICENSE` file regardless of the `files` allowlist, so no
 * package needs a `files` entry for it.
 *
 * Private packages (the examples) are skipped — nothing is distributed.
 *
 * Like its sibling {@link file://./check-package-readmes.mjs}, this gate
 * SELF-TESTS against canaries that must fail. A comparison that has stopped
 * discriminating — narrowed to a prefix, made whitespace-insensitive, reduced to
 * a length — reports universal coverage, which is indistinguishable from there
 * being nothing to find.
 *
 * Usage:
 *   node scripts/check-licenses.mjs            # verify; exit 1 on drift
 *   node scripts/check-licenses.mjs --write    # (re)create the copies
 *   node scripts/check-licenses.mjs --self-test  # canaries only
 */

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LICENSE = join(REPO_ROOT, 'LICENSE');

/** Workspace directories that may contain publishable packages. */
const WORKSPACE_DIRS = ['packages', 'examples'];

/** Immediate subdirectories, skipping the installed tree. */
function subdirectories(base) {
   if (!existsSync(base)) {
      return [];
   }
   return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
      .map(entry => join(base, entry.name));
}

/**
 * Package directories under a workspace directory, one grouping level deep.
 *
 * A child WITHOUT a `package.json` is descended into rather than skipped: an
 * example family is a plain grouping directory holding one package per host, so
 * a flat scan would stop covering every package it contains while still
 * reporting a clean verdict. One level only — deeper is a fixture tree or build
 * output, never a workspace member.
 */
function listPackageDirs(base) {
   return subdirectories(base).flatMap(directory =>
      existsSync(join(directory, 'package.json'))
         ? [directory]
         : subdirectories(directory).filter(nested => existsSync(join(nested, 'package.json')))
   );
}

/**
 * Every publishable workspace package: has a `package.json` and is not marked
 * `private`.
 */
function listPublishedPackages() {
   return WORKSPACE_DIRS.flatMap(workspaceDir =>
      listPackageDirs(join(REPO_ROOT, workspaceDir))
         .map(directory => ({
            directory,
            manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8'))
         }))
         .filter(({ manifest }) => manifest.private !== true)
         .map(({ directory, manifest }) => ({ directory, name: manifest.name }))
   );
}

/**
 * Why this package's LICENSE would not discharge MIT's inclusion requirement,
 * or undefined if it would. `undefined` contents stand for an absent file, and
 * the comparison is byte-exact: a notice that differs from the root one by a
 * holder, a year or a clause is a different licence grant, not a formatting
 * variant. Takes the contents rather than a path so the canaries exercise the
 * same predicate the real scan does.
 */
function licenseProblem(contents, expected) {
   if (contents === undefined) {
      return 'missing LICENSE';
   }
   if (contents !== expected) {
      return 'LICENSE differs from the root LICENSE';
   }
   return undefined;
}

/**
 * The expected notice, in the canaries' world. Deliberately not the real
 * `LICENSE`: a self-test that reads the file under test passes whatever that
 * file happens to say, so it could not tell a correct comparison from one
 * comparing the root against itself.
 */
const CANARY_LICENSE = ['MIT License', '', 'Copyright (c) 2026 Canary Holder', '', 'Permission is hereby granted.', ''].join('\n');

/**
 * The canaries. `problem: undefined` is the discrimination case — without one, a
 * comparison that had degenerated into "always differs" would satisfy every
 * must-fail canary and redden every package instead.
 *
 * Each must-fail case is the expected notice altered in exactly ONE way, and
 * each way corresponds to a degeneration the byte-exact comparison rejects:
 * absence, truncation, whitespace drift, and a substituted copyright holder —
 * the last being the one that survives every weaker comparison, since it keeps
 * the length and the structure and changes only the grant.
 */
const CANARIES = [
   { name: 'missing', contents: undefined, problem: 'missing LICENSE' },
   { name: 'truncated', contents: CANARY_LICENSE.replace('Permission is hereby granted.\n', ''), problem: 'differs from the root' },
   { name: 'trailing-whitespace', contents: `${CANARY_LICENSE}\n`, problem: 'differs from the root' },
   {
      name: 'other-holder',
      contents: CANARY_LICENSE.replace('Canary Holder', 'Other Holder'),
      problem: 'differs from the root'
   },
   { name: 'identical', contents: CANARY_LICENSE, problem: undefined }
];

function runSelfTest() {
   const problems = [];
   for (const canary of CANARIES) {
      const actual = licenseProblem(canary.contents, CANARY_LICENSE);
      if (canary.problem === undefined) {
         if (actual !== undefined) {
            problems.push(`canary ${canary.name} must pass but was rejected: ${actual}`);
         }
      } else if (actual === undefined) {
         problems.push(`canary ${canary.name} must fail with "${canary.problem}" but passed`);
      } else if (!actual.includes(canary.problem)) {
         problems.push(`canary ${canary.name} failed with "${actual}", expected "${canary.problem}"`);
      }
   }
   return problems;
}

function main() {
   const selfTestProblems = runSelfTest();
   if (selfTestProblems.length > 0) {
      console.error('Self-test FAILED — the gate no longer discriminates, so its verdict is worthless:');
      selfTestProblems.forEach(problem => console.error(`  ${problem}`));
      process.exit(2);
   }
   if (process.argv.includes('--self-test')) {
      console.log(`✓ self-test: ${CANARIES.length} canaries behave as specified`);
      return;
   }

   const write = process.argv.slice(2).includes('--write');

   if (!existsSync(ROOT_LICENSE)) {
      console.error(`Root LICENSE not found at ${ROOT_LICENSE}`);
      process.exit(2);
   }
   const expected = readFileSync(ROOT_LICENSE, 'utf-8');
   const packages = listPublishedPackages();

   const problems = [];
   for (const { directory, name } of packages) {
      const target = join(directory, 'LICENSE');
      if (write) {
         copyFileSync(ROOT_LICENSE, target);
         continue;
      }
      const contents = existsSync(target) ? readFileSync(target, 'utf-8') : undefined;
      const problem = licenseProblem(contents, expected);
      if (problem) {
         problems.push(`${name}: ${problem}`);
      }
   }

   if (write) {
      console.log(`✓ wrote LICENSE into ${packages.length} published packages`);
      process.exit(0);
   }

   if (problems.length > 0) {
      problems.forEach(problem => console.error(problem));
      console.error('\nRun `node scripts/check-licenses.mjs --write` to sync them.');
      process.exit(1);
   }

   console.log(`✓ all ${packages.length} published packages carry the root LICENSE`);
}

main();
