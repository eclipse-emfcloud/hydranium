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
 * Two agreements about declared dependency RANGES that nothing else asserts.
 *
 * **Pass A — the lockfile against the manifests.** Every dependency block of
 * every workspace manifest must be reproduced verbatim in that workspace's
 * `package-lock.json` entry, in both directions: a range the manifest declares
 * and the lock does not record, and a range the lock records that no manifest
 * asks for. `npm ci` does not settle this — it validates only the subset it
 * needs to build the tree, so a workspace entry can carry a superseded range
 * for a package that resolves fine anyway, and nothing anywhere notices. It was
 * divergent when this gate was written: nineteen entries carried twelve
 * disagreements, including a nested second physical copy of `@types/node` that
 * existed ONLY because the lock still recorded a `^20` devDependency where the
 * manifest had moved to `^22`. A second physical copy is precisely what the
 * root `overrides` block exists to prevent.
 *
 * This pass COMPARES rather than regenerating, and that is the load-bearing
 * design choice. Regenerating needs `npm install --package-lock-only`, which
 * (a) may reach the network, (b) rewrites nine hundred kilobytes to answer a
 * yes/no question, and (c) is not guaranteed to reach its own fixed point in
 * one pass — how many it takes depends on what moved, and a two-pass
 * convergence has been measured here. A regenerate-and-diff gate would
 * therefore report a false RED on a lock that is perfectly fresh. Comparison
 * has none of those properties and answers the same question.
 *
 * **Pass B — the mirrors against each other.** Inside `packages/*`, one package
 * name declared in the same block by two packages must carry the SAME literal.
 * The framework mirrors every peer it compiles against as a devDependency, so
 * one third-party version now appears in up to a dozen manifests where it used
 * to appear in one or two, and nothing asserted that they agree. The repo
 * already treats such a mirror as a version SOURCE rather than as a
 * convenience: the provenance gate reads `packages/cli`'s `vscode-languageserver`
 * devDependency as the canonical pin for everything `hydranium-cli init` emits,
 * so a mirror drifting is a scaffold emitting the wrong pin.
 *
 * Two things this pass deliberately does not do:
 *
 * - **It compares within a BLOCK, never across blocks.** A `peerDependencies`
 *   range states what an adopter may supply and a `devDependencies` literal
 *   states what we compile against, so the two disagreeing is the convention
 *   working — ten of this repo's mirror groups are exactly that shape. A
 *   cross-block rule would report all ten and could only be silenced by
 *   destroying the distinction.
 * - **It stops at `packages/*`.** An example loosens a range on purpose, which
 *   is recorded in its provenance table, and the on-ramp example pins exactly
 *   what the scaffold emits. Extending this pass over `examples/*` reports four
 *   further groups, every one of them deliberate.
 *
 * Usage: node scripts/check-dependency-agreement.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every block npm resolves a range from. */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Mirror groups allowed to disagree, each carrying the measurement that says
 * which literal is right, so an exemption states its own repair rather than
 * deferring it to whoever next reads the gate's output. Empty is the intended
 * steady state: an entry is a debt, not a policy.
 *
 * A stale exemption FAILS. An entry naming a group that now agrees is reported
 * as an error, not skipped: an exemption list that outlives its cause is how a
 * gate quietly stops covering something it is supposed to cover, and this one
 * is small enough that the only safe policy is that it must be exactly right.
 * Repairing a group needs the lockfile regenerated with the manifest, so an
 * entry here means the repair was deferred, never that the drift is correct.
 */
const MIRROR_EXEMPTIONS = [];

/** POSIX-spelled repo-relative directory, which is how both the lock and `workspaces` spell them. */
function workspaceDirectories(rootManifest) {
   const expand = entry => {
      let directories = [''];
      for (const segment of entry.split('/')) {
         directories = segment.includes('*')
            ? directories.flatMap(directory =>
                 readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })
                    .filter(child => child.isDirectory())
                    .map(child => (directory === '' ? child.name : `${directory}/${child.name}`))
              )
            : directories.map(directory => (directory === '' ? segment : `${directory}/${segment}`));
      }
      // A directory with no manifest is npm's problem, not this gate's.
      return directories.filter(directory => existsSync(join(REPO_ROOT, directory, 'package.json')));
   };
   return (rootManifest.workspaces ?? []).flatMap(expand);
}

function readJson(...segments) {
   return JSON.parse(readFileSync(join(REPO_ROOT, ...segments), 'utf-8'));
}

/**
 * Pass A, as a pure function so the self-test can drive it with fabricated
 * input. `manifests` maps a workspace directory (`''` for the root) to its
 * parsed manifest; `lockPackages` is the lock's own `packages` object, keyed the
 * same way.
 */
export function lockDisagreements(manifests, lockPackages) {
   const problems = [];
   for (const [directory, manifest] of Object.entries(manifests)) {
      const where = directory === '' ? '<root>' : directory;
      const entry = lockPackages[directory];
      if (entry === undefined) {
         problems.push(`${where}: the lockfile has no entry for this workspace`);
         continue;
      }
      for (const block of DEPENDENCY_BLOCKS) {
         const declared = manifest[block] ?? {};
         const recorded = entry[block] ?? {};
         for (const [name, range] of Object.entries(declared)) {
            if (recorded[name] === undefined)
               problems.push(`${where} ${block}.${name}: manifest declares ${range}, the lockfile records nothing`);
            else if (recorded[name] !== range)
               problems.push(`${where} ${block}.${name}: manifest declares ${range}, the lockfile records ${recorded[name]}`);
         }
         for (const [name, range] of Object.entries(recorded)) {
            if (declared[name] === undefined)
               problems.push(`${where} ${block}.${name}: the lockfile records ${range}, no manifest declares it`);
         }
      }
   }
   return problems;
}

/**
 * Pass B, likewise pure. `manifests` maps a `packages/<dir>` directory to its
 * parsed manifest. Returns both the drifts that are not exempt and the
 * exemptions that no longer name a drift.
 */
export function mirrorDisagreements(manifests, exemptions = MIRROR_EXEMPTIONS) {
   const groups = new Map();
   for (const [directory, manifest] of Object.entries(manifests)) {
      for (const block of DEPENDENCY_BLOCKS) {
         for (const [name, range] of Object.entries(manifest[block] ?? {})) {
            const key = `${block} ${name}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ directory, range });
         }
      }
   }

   const drifted = new Set();
   const problems = [];
   for (const [key, sites] of [...groups].sort()) {
      if (sites.length < 2) continue;
      if (new Set(sites.map(site => site.range)).size === 1) continue;
      drifted.add(key);
      if (exemptions.some(exemption => `${exemption.block} ${exemption.name}` === key)) continue;
      problems.push(`${key}: ${sites.map(site => `${site.directory} declares ${site.range}`).join(', ')}`);
   }

   const stale = exemptions
      .filter(exemption => !drifted.has(`${exemption.block} ${exemption.name}`))
      .map(
         exemption =>
            `${exemption.block} ${exemption.name} is exempted but no longer disagrees — delete the exemption, or the gate has stopped covering it`
      );
   return [...problems, ...stale];
}

/**
 * Fabricated inputs that MUST be judged a particular way, in both directions.
 * The repo agrees with itself today, so a clean run says nothing about whether
 * either pass still discriminates — and a comparison gate degrades silently
 * into universal agreement the moment its key spelling or its block list stops
 * matching the data.
 */
const SELF_TESTS = [
   {
      name: 'pass A: a range the lockfile records differently is reported',
      expect: 1,
      run: () =>
         lockDisagreements({ 'packages/a': { dependencies: { dep: '^1.0.0' } } }, { 'packages/a': { dependencies: { dep: '^2.0.0' } } })
   },
   {
      name: 'pass A: a range the lockfile does not record at all is reported',
      expect: 1,
      run: () => lockDisagreements({ 'packages/a': { devDependencies: { dep: '^1.0.0' } } }, { 'packages/a': {} })
   },
   {
      name: 'pass A: a range only the lockfile carries is reported',
      expect: 1,
      run: () => lockDisagreements({ 'packages/a': {} }, { 'packages/a': { dependencies: { dep: '^1.0.0' } } })
   },
   {
      name: 'pass A: a workspace with no lock entry at all is reported',
      expect: 1,
      run: () => lockDisagreements({ 'packages/a': { dependencies: { dep: '^1.0.0' } } }, {})
   },
   {
      name: 'pass A: an agreeing pair is not reported',
      expect: 0,
      run: () =>
         lockDisagreements(
            { '': { dependencies: { dep: '^1.0.0' } }, 'packages/a': { peerDependencies: { dep: '^1 || ^2' } } },
            { '': { dependencies: { dep: '^1.0.0' } }, 'packages/a': { peerDependencies: { dep: '^1 || ^2' } } }
         )
   },
   {
      name: 'pass B: two packages disagreeing within one block are reported',
      expect: 1,
      run: () =>
         mirrorDisagreements(
            { 'packages/a': { devDependencies: { dep: '1.0.0' } }, 'packages/b': { devDependencies: { dep: '^1.0.0' } } },
            []
         )
   },
   {
      name: 'pass B: the same literal in two packages is not reported',
      expect: 0,
      run: () =>
         mirrorDisagreements(
            { 'packages/a': { devDependencies: { dep: '1.0.0' } }, 'packages/b': { devDependencies: { dep: '1.0.0' } } },
            []
         )
   },
   {
      name: 'pass B: a dev pin beside a peer range is not reported — different blocks',
      expect: 0,
      run: () => mirrorDisagreements({ 'packages/a': { devDependencies: { dep: '1.0.0' }, peerDependencies: { dep: '^1.0.0' } } }, [])
   },
   {
      name: 'pass B: a declared exemption silences its own group and nothing else',
      expect: 1,
      run: () =>
         mirrorDisagreements(
            {
               'packages/a': { devDependencies: { dep: '1.0.0', other: '2.0.0' } },
               'packages/b': { devDependencies: { dep: '^1.0.0', other: '^2.0.0' } }
            },
            [{ block: 'devDependencies', name: 'dep', reason: 'fabricated' }]
         )
   },
   {
      name: 'pass B: an exemption whose group now agrees is reported as stale',
      expect: 1,
      run: () =>
         mirrorDisagreements({ 'packages/a': { devDependencies: { dep: '1.0.0' } }, 'packages/b': { devDependencies: { dep: '1.0.0' } } }, [
            { block: 'devDependencies', name: 'dep', reason: 'fabricated' }
         ])
   }
];

function runSelfTests() {
   let broken = false;
   for (const probe of SELF_TESTS) {
      const problems = probe.run();
      if (problems.length === probe.expect) {
         console.log(`✓ self-test: ${probe.name}`);
         continue;
      }
      broken = true;
      console.error(`✗ SELF-TEST FAILED: ${probe.name} — expected ${probe.expect}, got ${problems.length}: ${JSON.stringify(problems)}`);
   }
   return broken;
}

let failed = runSelfTests();
console.log('');

const rootManifest = readJson('package.json');
const directories = workspaceDirectories(rootManifest);
// The `workspaces` list is ground truth for every other coverage gate here, so
// a list that has stopped expanding must abort rather than report agreement
// over nothing.
if (directories.length === 0) {
   console.error('✗ SELF-TEST FAILED: the root `workspaces` list expanded to no directories — this gate compared nothing');
   process.exit(1);
}

const manifests = { '': rootManifest };
for (const directory of directories) manifests[directory] = readJson(directory, 'package.json');

const lockProblems = lockDisagreements(manifests, readJson('package-lock.json').packages ?? {});
if (lockProblems.length > 0) {
   failed = true;
   console.error(
      `✗ the lockfile disagrees with ${lockProblems.length} declared range(s) — regenerate it with \`npm install --package-lock-only\` (twice):`
   );
   for (const problem of lockProblems) console.error(`    ${problem}`);
} else {
   console.log(`✓ every declared range in ${Object.keys(manifests).length} workspace manifest(s) is reproduced by the lockfile`);
}

const frameworkManifests = Object.fromEntries(Object.entries(manifests).filter(([directory]) => directory.startsWith('packages/')));
const mirrorProblems = mirrorDisagreements(frameworkManifests);
if (mirrorProblems.length > 0) {
   failed = true;
   console.error(`✗ ${mirrorProblems.length} mirrored range(s) disagree across packages/*:`);
   for (const problem of mirrorProblems) console.error(`    ${problem}`);
} else {
   const exempted = MIRROR_EXEMPTIONS.length === 0 ? '' : `, bar ${MIRROR_EXEMPTIONS.length} recorded exemption(s)`;
   console.log(`✓ every range mirrored across ${Object.keys(frameworkManifests).length} framework package(s) agrees${exempted}`);
}

if (failed) {
   console.error('\nDependency-agreement gate failed.');
   console.error('(A SELF-TEST failure means the opposite — a pass stopped discriminating, so fix the gate.)');
   process.exit(1);
}
