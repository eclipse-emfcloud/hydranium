/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The release driver: stamps a version across the publishable packages and
// publishes them in lockstep.
//
//   node scripts/release.mjs next   [--dry-run]
//   node scripts/release.mjs latest [--dry-run]
//
// `next` derives a rolling prerelease from the committed base — `1.0.0-next`
// plus the number of commits since the last release tag — and is what every
// merge publishes. `latest` publishes the versions already committed, and is
// the stable cut.
//
// Why a script rather than `npm publish --workspaces` in the workflow: npm does
// none of the three things that actually have to happen. It cannot derive the
// counter, it cannot rewrite the intra-framework ranges (there is no
// `workspace:` protocol here, so a published tarball would carry the literal
// committed range), and it cannot tell the two release lines apart. Keeping it
// in a script also makes the whole sequence runnable with `--dry-run` before
// any of it touches a registry.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

// Deliberately narrower than `v*`: this repository carries marker tags such as
// `v0-api-freeze`, and a naive `v[0-9]*` matches that one — `v` followed by
// `0-api-freeze` — which would silently anchor the counter to a tag that is not
// a release. Requiring all three dot-separated numeric segments excludes it.
const RELEASE_TAG_GLOB = 'v[0-9]*.[0-9]*.[0-9]*';

/** A version on the rolling line, as opposed to a stable one. */
function isNextVersion(version) {
   return version.endsWith('-next');
}

// stderr is captured rather than inherited so a probing call that is EXPECTED
// to fail — `describe` against a repository with no release tag — does not
// print git's own `fatal:` ahead of the message that explains it.
function git(args) {
   return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readManifest(file) {
   return JSON.parse(readFileSync(file, 'utf-8'));
}

/**
 * The packages this script publishes, and the names it rewrites ranges for.
 *
 * `private` packages are excluded from publishing but NOT from the name set: an
 * example that peers on a framework package still has to resolve, so its ranges
 * move with the rest.
 */
function loadWorkspace() {
   const packages = readdirSync(PACKAGES_DIR)
      .map(entry => join(PACKAGES_DIR, entry, 'package.json'))
      .filter(file => {
         try {
            readFileSync(file);
            return true;
         } catch {
            return false;
         }
      })
      .map(file => ({ file, dir: dirname(file), manifest: readManifest(file) }));
   const names = new Set(packages.map(pkg => pkg.manifest.name));
   return { packages, names };
}

/** The base version every publishable package is expected to agree on. */
function readBaseVersion(packages) {
   const bases = new Set(packages.map(pkg => pkg.manifest.version));
   if (bases.size !== 1) {
      throw new Error(
         `The packages do not agree on a base version (${[...bases].sort().join(', ')}). ` +
            'Fixed versioning means they publish as one set, so a split base is a bug rather than a state to publish from.'
      );
   }
   return [...bases][0];
}

/**
 * `<base>.<commits since the last release tag>`.
 *
 * Requires a tag and the full history: a shallow clone resolves no tag and a
 * repository with none cannot place the counter at all, so both fail loudly
 * here rather than producing a plausible wrong number.
 */
function deriveRollingVersion(base) {
   let lastTag;
   try {
      lastTag = git(['describe', '--tags', '--abbrev=0', '--match', RELEASE_TAG_GLOB]);
   } catch {
      throw new Error(
         `No tag matching '${RELEASE_TAG_GLOB}' is reachable. The rolling counter is measured from the last ` +
            'release tag, so one has to exist, and CI needs fetch-depth: 0 to see it.'
      );
   }
   const count = Number.parseInt(git(['rev-list', '--count', `${lastTag}..HEAD`]), 10);
   if (Number.isNaN(count)) {
      throw new Error(`Could not count the commits since '${lastTag}'.`);
   }
   return { version: `${base}.${count}`, lastTag, count };
}

/**
 * Write `version` onto every package and pin every intra-framework range to it
 * EXACTLY.
 *
 * Exact rather than caret, and the difference is not stylistic: `^1.0.0-next.7`
 * also matches `1.0.0` and `1.1.0`, so a caret minted on a prerelease would let
 * a consumer of one nightly silently resolve a sibling package from a future
 * stable line. The published set has to be the set that was built together.
 */
function stamp(workspace, version) {
   for (const pkg of workspace.packages) {
      pkg.manifest.version = version;
      for (const block of ['dependencies', 'devDependencies', 'peerDependencies']) {
         for (const name of Object.keys(pkg.manifest[block] ?? {})) {
            if (workspace.names.has(name)) {
               pkg.manifest[block][name] = version;
            }
         }
      }
      writeFileSync(pkg.file, `${JSON.stringify(pkg.manifest, undefined, 2)}\n`);
   }
}

/**
 * Whether a stable version of `name` already exists on the registry.
 *
 * This is what decides the dist-tag, rather than a constant somebody has to
 * remember to flip at the first stable release. Before that release `latest`
 * has to track the newest prerelease, because npm assigns `latest` to the first
 * version of a new package whatever `--tag` asks for — so publishing only to
 * `next` would strand `latest` on the very first nightly forever. Afterwards
 * `latest` belongs to the stable line and the rolling one moves to `next`.
 *
 * A package that does not exist yet has no stable release, which is the
 * bootstrap case and not an error.
 */
function hasStableRelease(name) {
   let output;
   try {
      output = execFileSync('npm', ['view', name, 'versions', '--json'], {
         encoding: 'utf-8',
         stdio: ['ignore', 'pipe', 'pipe']
      });
   } catch (error) {
      if (String(error.stderr ?? '').includes('E404')) {
         return false;
      }
      throw new Error(`Could not read the published versions of ${name}: ${error.stderr ?? error.message}`);
   }
   const versions = JSON.parse(output);
   return (Array.isArray(versions) ? versions : [versions]).some(version => !version.includes('-'));
}

function publishablePackages(workspace) {
   return workspace.packages.filter(pkg => pkg.manifest.private !== true);
}

function publish(pkg, distTag, dryRun) {
   const args = ['publish', '--tag', distTag];
   if (dryRun) {
      args.push('--dry-run');
   }
   execFileSync('npm', args, { cwd: pkg.dir, stdio: 'inherit' });
}

/**
 * Confirm every package actually landed.
 *
 * Ten packages publish as one set, so a partial publish leaves the set
 * incoherent while the workflow still reports success — the failure this
 * exists for is a green run over a half-published release.
 */
function verifyPublished(packages, version) {
   const missing = [];
   for (const pkg of packages) {
      const name = pkg.manifest.name;
      try {
         const seen = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe']
         }).trim();
         if (seen !== version) {
            missing.push(`${name} (registry reports '${seen}')`);
         }
      } catch {
         missing.push(name);
      }
   }
   if (missing.length > 0) {
      throw new Error(`Published ${packages.length} packages but the registry does not serve ${version} for:\n  ${missing.join('\n  ')}`);
   }
   console.log(`✓ all ${packages.length} packages serve ${version}`);
}

function releaseNext(workspace, dryRun) {
   const base = readBaseVersion(workspace.packages);
   if (!isNextVersion(base)) {
      throw new Error(
         `The committed base is '${base}', which is not a rolling version. ` +
            'Either the base was never moved on after a stable release, or this should be a `latest` run.'
      );
   }
   const { version, lastTag, count } = deriveRollingVersion(base);
   console.log(`Rolling release ${version} (${count} commits since ${lastTag})`);

   const packages = publishablePackages(workspace);
   const distTag = packages.some(pkg => hasStableRelease(pkg.manifest.name)) ? 'next' : 'latest';
   console.log(`Publishing ${packages.length} packages under '${distTag}'`);

   stamp(workspace, version);
   for (const pkg of packages) {
      publish(pkg, distTag, dryRun);
   }
   if (!dryRun) {
      verifyPublished(packages, version);
   }
}

function releaseLatest(workspace, dryRun) {
   const base = readBaseVersion(workspace.packages);
   if (isNextVersion(base)) {
      throw new Error(
         `The committed base is '${base}', a rolling version. Refusing to publish it as a stable release — ` +
            'cut the stable version first, and move the base on to the next rolling one in the same commit.'
      );
   }
   const packages = publishablePackages(workspace);
   console.log(`Stable release ${base}: publishing ${packages.length} packages under 'latest'`);

   // Pin the intra-framework ranges the same way the rolling line does; the
   // committed ranges are a base, not the published set.
   stamp(workspace, base);
   for (const pkg of packages) {
      publish(pkg, 'latest', dryRun);
   }
   if (!dryRun) {
      verifyPublished(packages, base);
   }
}

function main() {
   const args = process.argv.slice(2);
   const dryRun = args.includes('--dry-run');
   const mode = args.find(arg => !arg.startsWith('--'));
   if (mode !== 'next' && mode !== 'latest') {
      console.error('Usage: node scripts/release.mjs <next|latest> [--dry-run]');
      process.exit(1);
   }

   const workspace = loadWorkspace();
   if (mode === 'next') {
      releaseNext(workspace, dryRun);
   } else {
      releaseLatest(workspace, dryRun);
   }
}

main();
