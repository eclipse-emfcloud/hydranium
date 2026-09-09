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

// Deliberately narrower than `v*`, and than `v[0-9]*`: both also match a
// `v`-prefixed marker tag, which would silently anchor the counter to a tag
// that is not a release. All three dot-separated numeric segments are required.
const RELEASE_TAG_GLOB = 'v[0-9]*.[0-9]*.[0-9]*';

/**
 * Re-reads while the registry propagates; see {@link reportPublished}.
 *
 * A round covers every package still pending, so the linear backoff is shared
 * rather than paid per straggler — twenty-four seconds in total, however many
 * lag. Per-package it would multiply by the number of stragglers instead.
 *
 * Short, because the read it retries decides nothing. Three minutes was tried
 * while this was a gate and was not enough either: the endpoint stayed stale
 * past the whole budget, so the only thing a longer wait bought was a later
 * red on a release that had already succeeded.
 */
const REPORT_ROUNDS = 4;
const REPORT_BACKOFF_MS = 4_000;

/**
 * What `distTag` currently points at for `name`, or undefined.
 *
 * Reads the dist-tag endpoint rather than the package document, because the
 * latter is served through a CDN that caches NEGATIVE responses and every name
 * here is queried while it does not yet exist. Measured during the first
 * publish: `npm view` returned 404 for packages `npm dist-tag ls` reported as
 * live.
 */
function publishedTag(name, distTag) {
   let output;
   try {
      output = execFileSync('npm', ['dist-tag', 'ls', name], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
   } catch {
      return undefined;
   }
   // Parsed as TEXT. `npm dist-tag ls` accepts `--json` and ignores it, still
   // emitting `tag: version` lines — so `JSON.parse` throws, the catch returns
   // undefined, and every caller fails OPEN rather than loudly.
   for (const line of output.split('\n')) {
      const separator = line.indexOf(':');
      if (separator > 0 && line.slice(0, separator).trim() === distTag) {
         return line.slice(separator + 1).trim();
      }
   }
   return undefined;
}

/** Blocks the thread. The script is synchronous throughout; a timer would not run. */
function sleepSync(ms) {
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
 *
 * **A dry run must not reach the disk.** CI stamps a throwaway tree, but a
 * human runs `--dry-run` in a real clone, and writing there desynchronises
 * every manifest from the lockfile: the workspace versions no longer match the
 * ranges recorded against them, so npm stops resolving them as links and asks
 * the REGISTRY for a version that has never been published. The install then
 * fails with a 404 naming a first-party package, which reads as a broken
 * lockfile rather than as a dry run that mutated the tree.
 */
function stamp(workspace, version, dryRun) {
   if (dryRun) {
      console.log(`[dry-run] would stamp ${workspace.packages.length} manifests to ${version}`);
      console.log('[dry-run] the pack below therefore reports the committed base, not that version');
      return;
   }
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

/**
 * Publish one package, treating "this version already exists" as a SKIP.
 *
 * Detected from the registry's rejection rather than by asking first, because
 * a pre-check reads the same cached document {@link reportPublished} cannot
 * trust, and a stale answer either skips a package that needs publishing or
 * attempts one that does not. The write path gets the authoritative answer.
 *
 * Without this a PARTIAL publish is unrecoverable: the packages that succeeded
 * reject a re-run, and the version cannot be advanced without a new commit,
 * because it is derived from the commit count rather than stored.
 */
function publish(pkg, distTag, dryRun) {
   const args = ['publish', '--tag', distTag];
   if (dryRun) {
      args.push('--dry-run');
   }
   if (!dryRun && publishedTag(pkg.manifest.name, distTag) === pkg.manifest.version) {
      console.log(`- ${pkg.manifest.name}@${pkg.manifest.version} already on '${distTag}', skipping`);
      return 'skipped';
   }
   // FULLY inherited, deliberately. Capturing stderr to read npm's rejection
   // was tried and is wrong twice over: `inherit` discards it so the match
   // never fires, and piping it prevents npm running its interactive one-time
   // password prompt, so a local publish dies on EOTP instead of asking.
   execFileSync('npm', args, { cwd: pkg.dir, stdio: 'inherit' });
   return 'published';
}

/**
 * Report which packages already serve `version` on `distTag`.
 *
 * A REPORT and not a gate, which is the whole point of it. The publish is the
 * verification: npm acknowledges each write with its own `+ name@version` line
 * and a rejected publish throws from the command itself, so by the time this
 * runs the registry has already accepted all of them. Everything here is a
 * read back through a CDN, and that read has been observed serving a
 * superseded version for longer than three minutes — long enough that failing
 * on it reddened roughly half of all releases AFTER the publishes had landed.
 * A verdict that is wrong half the time is worse than no verdict, because the
 * one real failure arrives looking exactly like the noise.
 *
 * Read on the dist-tag endpoint rather than the package document, which is
 * where a first publish went wrong: `npm view` caches NEGATIVE responses, and
 * the bootstrap queries every name while it does not yet exist, so it returned
 * a stale 404 for packages that were live. Swapping endpoints would only move
 * the staleness, since both are cached — hence reporting rather than gating.
 *
 * Retried in rounds over the packages still pending, so waiting on one re-reads
 * the rest for free. The budget is short deliberately: it buys a tidier report,
 * never a verdict, so there is nothing to be gained by waiting longer.
 */
function reportPublished(packages, version, distTag) {
   // Holds the last version seen, not just the name: the report has to tell a
   // tag serving the PREVIOUS version apart from one it could not read.
   const pending = new Map(packages.map(pkg => [pkg.manifest.name, undefined]));
   for (let round = 0; round < REPORT_ROUNDS && pending.size > 0; round++) {
      if (round > 0) {
         sleepSync(REPORT_BACKOFF_MS * round);
      }
      for (const name of [...pending.keys()]) {
         const seen = publishedTag(name, distTag);
         if (seen === version) {
            pending.delete(name);
         } else {
            pending.set(name, seen);
         }
      }
   }
   if (pending.size === 0) {
      console.log(`✓ all ${packages.length} packages serve ${version} on '${distTag}'`);
      return;
   }
   const lagging = [...pending].map(([name, seen]) => `${name} (${distTag} → ${seen ?? 'unreadable'})`);
   console.warn(
      `\n! '${distTag}' does not yet point at ${version} for:\n  ${lagging.join('\n  ')}\n\n` +
         `The publishes above succeeded, so this is the read catching up rather than a failed\n` +
         `release. Confirm with \`npm dist-tag ls <package>\`; it has always caught up so far.\n`
   );
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

   stamp(workspace, version, dryRun);
   for (const pkg of packages) {
      publish(pkg, distTag, dryRun);
   }
   if (!dryRun) {
      reportPublished(packages, version, distTag);
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
   stamp(workspace, base, dryRun);
   for (const pkg of packages) {
      publish(pkg, 'latest', dryRun);
   }
   if (!dryRun) {
      reportPublished(packages, base, 'latest');
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
