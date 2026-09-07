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
 * Coverage gate for the tool configuration that is addressed BY GLOB.
 *
 * Every other `check:` script asserts something about content. This one asserts
 * that the other tools still REACH the packages they claim to cover, which is a
 * different failure and a silent one: an `eslint` `files` glob that matches
 * nothing leaves its rules UNSET rather than passing, and `--max-warnings 0`
 * cannot tell unset from clean. A `vitest` `projects` glob that matches nothing
 * simply contributes no suites. Neither is an error anywhere.
 *
 * Why it exists: moving `order-flow` one directory deeper turned three
 * `examples/*` globs into no-ops at once. The full gate stayed green through all
 * of it, including the phantom-dependency rule that had been added specifically
 * because the example server was importing packages it did not declare. A glob
 * is a claim about which files a rule governs, and this makes that claim
 * executable.
 *
 * Ground truth is the root `workspaces` list, because that is what npm, turbo
 * and the publish flow already agree on — so a package cannot be covered here
 * and invisible there, or the reverse.
 *
 * The tools are INTERROGATED wherever they can answer, never re-implemented:
 * eslint through `calculateConfigForFile`, vitest through the config that vite's
 * own loader returns, and every file-matching question through `git ls-files`. A glob matcher
 * of our own would be a second implementation to drift from the real one — and
 * where one is unavoidable (the ignore files, which are matched by git and
 * prettier separately) it is deliberately CONSERVATIVE, asserting only what
 * cannot be intentional.
 *
 * Seven claims, each one an enumeration that has to agree with another:
 * - eslint's `import/no-extraneous-dependencies` governs every package's `src`
 * - and every package's `test` tree, under the other option set, with a
 *   `packageDir` naming both the package and the repo root
 * - eslint's import resolver names every package's `tsconfig.json`
 * - the root `vitest` `projects` reaches every package's `vitest.config.ts`
 * - the root solution `tsconfig.json` references every framework package
 * - every `turbo.json` input glob matches a file, so nothing hashes empty
 * - the README-snippet gate's discovery pass reaches every tracked README
 * - the neutrality gate's hand-maintained entry list still accounts for every
 *   public `exports` subpath, gated or excluded by name
 *
 * Usage: node scripts/check-glob-coverage.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** POSIX-spelled repo-relative path, which is what every glob here is written in. */
function repoRelative(absolutePath) {
   return relative(REPO_ROOT, absolutePath).split('\\').join('/');
}

/**
 * Expand one `workspaces` entry to the package directories it names.
 *
 * Only a trailing `*` is expanded, which is all the root manifest uses. An entry
 * naming a directory with no `package.json` is a problem for npm, not for this
 * gate, so it is dropped rather than reported here.
 */
function expandWorkspaceEntry(entry) {
   const segments = entry.split('/');
   let directories = [REPO_ROOT];
   for (const segment of segments) {
      directories = segment.includes('*')
         ? directories.flatMap(directory =>
              existsSync(directory)
                 ? readdirSync(directory, { withFileTypes: true })
                      .filter(child => child.isDirectory() && child.name !== 'node_modules')
                      .map(child => join(directory, child.name))
                 : []
           )
         : directories.map(directory => join(directory, segment));
   }
   return directories.filter(directory => existsSync(join(directory, 'package.json')));
}

/** Directories a `*`-globbed path names, without requiring a `package.json`. */
function expandGlobToDirectories(base, pattern) {
   let directories = [base];
   for (const segment of pattern.split('/').filter(Boolean)) {
      directories = segment.includes('*')
         ? directories.flatMap(directory =>
              existsSync(directory)
                 ? readdirSync(directory, { withFileTypes: true })
                      .filter(child => child.isDirectory() && segmentMatches(segment, child.name))
                      .map(child => join(directory, child.name))
                 : []
           )
         : directories.map(directory => join(directory, segment)).filter(existsSync);
   }
   return directories.filter(existsSync);
}

/** One path segment against a glob segment, where `*` is any run of non-separator. */
function segmentMatches(glob, segment) {
   const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
   return new RegExp(`^${source}$`).test(segment);
}

/**
 * Whether a glob matches at least one FILE under `base`.
 *
 * `git ls-files` rather than a walk, so build output and `node_modules` cannot
 * make a stale glob look live — the same reason the README gate uses it. Turbo
 * hashes tracked files too, so this is also the more faithful oracle.
 *
 * `:(glob)` magic is REQUIRED, not tidiness. git's default pathspec is fnmatch
 * without `FNM_PATHNAME`, under which `src/**` + `/*` demands a second separator
 * and so matches none of a flat `src/extension.ts` — the opposite of what turbo's
 * globber does with the same string, and it reported a live task as hashing
 * nothing. With the magic, `**` spans zero or more components as turbo means it.
 */
function globMatchesAnyFile(base, glob) {
   return trackedFiles([`:(glob)${glob}`], base).length > 0;
}

/** Tracked files matching any pathspec, repo-relative (or relative to `cwd`). */
function trackedFiles(pathspecs, cwd = REPO_ROOT) {
   const result = spawnSync('git', ['-C', cwd, 'ls-files', ...pathspecs], { encoding: 'utf-8' });
   if (result.status !== 0) {
      throw new Error(`git ls-files failed for ${pathspecs.join(' ')}: ${result.stderr}`);
   }
   return result.stdout.split('\n').filter(line => line.length > 0);
}

/** Every workspace package, as `{ dir, name }`, from the root manifest. */
function listWorkspacePackages() {
   const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
   return (manifest.workspaces ?? []).flatMap(expandWorkspaceEntry).map(directory => ({
      dir: directory,
      name: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8')).name
   }));
}

/**
 * The phantom-dependency rule's options for a path, or `undefined` if unset.
 *
 * The probe path need not exist: flat config resolves `files` globs against the
 * path, not against the filesystem. That is deliberate — a package whose `src`
 * happens to be empty is still supposed to be governed. A path matched by the
 * top-level `ignores` has NO config at all rather than an empty one, which
 * `calculateConfigForFile` signals by returning nothing.
 */
async function extraneousDependencyOptions(eslint, probePath) {
   const config = await eslint.calculateConfigForFile(probePath).catch(() => undefined);
   const entry = config?.rules?.['import/no-extraneous-dependencies'];
   return Array.isArray(entry) ? entry[1] : undefined;
}

async function hasExtraneousDependencyRule(eslint, probePath) {
   return (await extraneousDependencyOptions(eslint, probePath)) !== undefined;
}

/** The import resolver's `project` globs, as eslint itself resolves them. */
async function resolverProjectGlobs(eslint, probePath) {
   const config = await eslint.calculateConfigForFile(probePath);
   const project = config.settings?.['import/resolver']?.typescript?.project;
   return Array.isArray(project) ? project : [];
}

/**
 * Self-tests, run BEFORE the real assertions and fatal on failure.
 *
 * Without these a broken probe reports universal coverage and the gate passes
 * over nothing, which is the exact shape it exists to catch. Two canaries, and
 * the DISCRIMINATION one is the load-bearing half: `src` and `test` are governed
 * by the same rule under deliberately different options (`devDependencies` false
 * for shipping code, true for tests), so a probe returning a constant fails here
 * instead of reporting everything covered. The negative canary is a package-root
 * config file, which neither block claims.
 */
async function selfTest(eslint, packages) {
   const problems = [];

   const srcOptions = await extraneousDependencyOptions(eslint, join(REPO_ROOT, 'packages/core/src/__glob-probe__.ts'));
   const testOptions = await extraneousDependencyOptions(eslint, join(REPO_ROOT, 'packages/core/test/__glob-probe__.ts'));
   if (srcOptions?.devDependencies !== false || testOptions?.devDependencies !== true) {
      problems.push(
         'self-test: the phantom-dependency rule no longer distinguishes `src` (devDependencies: false) from `test` ' +
            '(devDependencies: true). The probe has stopped discriminating, so every "covered" verdict below is worthless.'
      );
   }
   const uncoveredByDesign = join(REPO_ROOT, 'packages/core/vitest.config.ts');
   if (await hasExtraneousDependencyRule(eslint, uncoveredByDesign)) {
      problems.push('self-test: the phantom-dependency rule reports as configured for a package-root config file, which no block claims.');
   }
   const coveredByDesign = join(REPO_ROOT, 'packages/core/src/__glob-probe__.ts');
   if (!(await hasExtraneousDependencyRule(eslint, coveredByDesign))) {
      problems.push('self-test: the phantom-dependency rule reports as absent for `packages/core/src`, where it is configured.');
   }

   // A ground truth of zero is how this gate would silently cover nothing.
   const examplePackages = packages.filter(({ dir }) => repoRelative(dir).startsWith('examples/'));
   if (examplePackages.length === 0) {
      problems.push('self-test: the root `workspaces` list expanded to no example packages, so there is nothing to check.');
   }

   // The neutrality-entry probe slices ONE array out of a file that holds two,
   // so a broken slice would return every entry for both names and report
   // universal coverage. Asserted by discrimination rather than by count: one
   // entry that must appear only in the gated list and one only in the excluded
   // list. If either moves, update the probe here — not the claim.
   const source = readFileSync(join(REPO_ROOT, 'scripts/check-neutral-bundles.mjs'), 'utf-8');
   const gated = neutralityEntries(source, 'TARGETS');
   const excluded = neutralityEntries(source, 'NOT_GATED');
   const gatedOnly = 'packages/core/lib/index.js';
   const excludedOnly = 'packages/langium/lib/test.js';
   if (!gated?.has(gatedOnly) || gated?.has(excludedOnly) || !excluded?.has(excludedOnly) || excluded?.has(gatedOnly)) {
      problems.push(
         'self-test: the TARGETS / NOT_GATED probe no longer separates the two arrays in check-neutral-bundles.mjs, ' +
            'so every "accounted for" verdict from it is worthless.'
      );
   }

   return problems;
}

/** Strip `//` line comments so `JSON.parse` accepts a tsc/turbo config. */
function readJsonWithComments(absolutePath) {
   return JSON.parse(
      readFileSync(absolutePath, 'utf-8')
         .split('\n')
         .map(line => (/^\s*\/\//.test(line) ? '' : line))
         .join('\n')
   );
}

/**
 * The root solution tsconfig must reference every framework package.
 *
 * A package missing here still builds under turbo, which runs each package's own
 * `build` — so the two disagree and only `npm run build` (a single root `tsc -b`)
 * is wrong, silently and only for whoever uses it. Examples are deliberately NOT
 * referenced: the root project is the framework graph, which is what lets
 * `watch:all` be one daemon that never rebuilds an example.
 */
function checkRootTsconfigReferences() {
   const problems = [];
   const referenced = new Set(readJsonWithComments(join(REPO_ROOT, 'tsconfig.json')).references?.map(entry => entry.path) ?? []);
   for (const directory of expandWorkspaceEntry('packages/*')) {
      const relativeDir = repoRelative(directory);
      if (existsSync(join(directory, 'tsconfig.json')) && !referenced.has(relativeDir)) {
         problems.push(
            `${relativeDir}: has a tsconfig.json but is not in the root tsconfig.json \`references\`, so \`npm run build\` (\`tsc -b\`) skips it while turbo still builds it.`
         );
      }
   }
   for (const path of referenced) {
      if (!existsSync(join(REPO_ROOT, path, 'tsconfig.json'))) {
         problems.push(`${path}: referenced by the root tsconfig.json but has no tsconfig.json.`);
      }
   }
   return problems;
}

/**
 * Every `turbo.json` input glob must match something.
 *
 * The hazard is one-directional and silent: an input that matches no file
 * contributes nothing to the task hash, so turbo replays a cached result over
 * changed sources. The `$TURBO_ROOT$`-anchored ones are the dangerous shape,
 * because they reach OUTSIDE the package — the browser example hashes the sample
 * workspace that way, and a stale path there serves the previous workspace while
 * every other host serves the new one.
 *
 * Only `$TURBO_ROOT$` inputs and the per-package UNION are asserted. A single
 * package-relative glob legitimately matches nothing — the root task list is a
 * union over every package shape, so `grammar/**` is empty for most — but a task
 * whose whole input set is empty is hashing nothing at all.
 */
function checkTurboInputs() {
   const problems = [];
   const rootTasks = readJsonWithComments(join(REPO_ROOT, 'turbo.json')).tasks ?? {};

   for (const { dir, name } of listWorkspacePackages()) {
      const localPath = join(dir, 'turbo.json');
      const localTasks = existsSync(localPath) ? (readJsonWithComments(localPath).tasks ?? {}) : {};
      const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).scripts ?? {};

      for (const [task, rootConfig] of Object.entries(rootTasks)) {
         const config = localTasks[task] ?? rootConfig;
         const inputs = config.inputs ?? [];
         if (inputs.length === 0 || scripts[task] === undefined) {
            continue;
         }
         const packageRelative = inputs.filter(glob => !glob.startsWith('$TURBO_ROOT$'));
         if (packageRelative.length > 0 && !packageRelative.some(glob => globMatchesAnyFile(dir, glob))) {
            problems.push(
               `${name}: every \`inputs\` glob of the \`${task}\` task matches no file, so turbo hashes nothing for it and will replay a cached result over changed sources.`
            );
         }
         for (const glob of inputs.filter(candidate => candidate.startsWith('$TURBO_ROOT$'))) {
            if (!globMatchesAnyFile(REPO_ROOT, glob.replace('$TURBO_ROOT$/', ''))) {
               problems.push(
                  `${name}: the \`${task}\` input \`${glob}\` matches no file. A $TURBO_ROOT$ input reaches outside the package, so a stale path silently drops those files from the hash.`
               );
            }
         }
      }
   }
   return problems;
}

/**
 * Ignore-file patterns whose WILDCARD DIRECTORY segment names nothing.
 *
 * A pattern matching no file today is normal — both files deliberately name
 * output that a clean checkout has not produced yet. What is never intentional is
 * a wildcard segment that can match no directory at all, which is what a renamed
 * or re-nested tree leaves behind: `examples/*-theia-app/plugins` went inert that
 * way, and prettier does not read `.gitignore`, so nothing else would have said
 * so. Asserted only up to the last wildcard segment, which is why a pattern
 * naming a not-yet-created leaf (`…/workspace/.vscode/settings.json`) still
 * passes.
 */
function checkIgnorePatterns() {
   const problems = [];
   for (const file of ['.gitignore', '.prettierignore']) {
      const lines = readFileSync(join(REPO_ROOT, file), 'utf-8')
         .split('\n')
         .map(line => line.trim())
         .filter(line => line.length > 0 && !line.startsWith('#'));
      for (const line of lines) {
         const negated = line.replace(/^!/, '');
         const segments = negated.replace(/\/$/, '').split('/');
         // A trailing `/` makes the last segment a directory; otherwise it names a
         // file, and a wildcard THERE is a filename wildcard that says nothing
         // about the tree (`…/gen-esbuild*.mjs` matches no directory by design).
         const directorySegments = negated.endsWith('/') ? segments : segments.slice(0, -1);
         const lastWildcard = directorySegments.reduce((last, segment, index) => (segment.includes('*') ? index : last), -1);
         // `**` crosses separators and a leading-wildcard pattern is depth-free;
         // neither can go inert through a rename, so neither is asserted.
         if (lastWildcard < 1 || directorySegments.slice(0, lastWildcard + 1).includes('**')) {
            continue;
         }
         const directoryPattern = directorySegments.slice(0, lastWildcard + 1).join('/');
         if (expandGlobToDirectories(REPO_ROOT, directoryPattern).length === 0) {
            problems.push(
               `${file}: the pattern \`${line}\` has a wildcard segment matching no directory (\`${directoryPattern}\`), so the rule is inert.`
            );
         }
      }
   }
   return problems;
}

/**
 * The README-snippet gate's discovery pass must reach every tracked README.
 *
 * That pass exists so a README growing its first fence becomes a build failure
 * rather than a silence — which makes its own pathspecs load-bearing in exactly
 * the way this script is about. `*README.md` crosses depths and so survived the
 * example re-nesting, but by luck rather than design.
 */
function checkSnippetDiscovery() {
   const problems = [];
   const source = readFileSync(join(REPO_ROOT, 'scripts/check-readme-snippet.mjs'), 'utf-8');
   const declared = /const DISCOVERY_PATHSPECS = \[([^\]]*)\]/.exec(source);
   if (declared === null) {
      return ['scripts/check-readme-snippet.mjs: could not read DISCOVERY_PATHSPECS, so its coverage cannot be checked.'];
   }
   const pathspecs = [...declared[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
   const reached = new Set(trackedFiles(pathspecs));
   for (const readme of trackedFiles(['*README.md'])) {
      // The changeset tool owns this one and it carries no fences.
      if (readme.startsWith('.changeset/') || reached.has(readme)) {
         continue;
      }
      problems.push(
         `${readme}: tracked README not reached by check-readme-snippet.mjs's DISCOVERY_PATHSPECS, so a fence added to it would be ungated.`
      );
   }
   return problems;
}

/**
 * The `entry:` paths of one named array literal in a sibling gate's source.
 *
 * Read textually, and for the same reason `checkSnippetDiscovery` reads its
 * target textually: importing `check-neutral-bundles.mjs` would EXECUTE it —
 * esbuild over every gated entry, which needs a build and takes seconds. The
 * failure direction is safe: a regex that stops matching some elements makes
 * them read as unaccounted for, so the claim below over-reports and fails loud
 * rather than reporting universal coverage.
 */
function neutralityEntries(source, arrayName) {
   const start = source.indexOf(`const ${arrayName} = [`);
   if (start === -1) {
      return undefined;
   }
   const end = source.indexOf('\n];', start);
   if (end === -1) {
      return undefined;
   }
   return new Set([...source.slice(start, end).matchAll(/entry: '([^']+)'/g)].map(match => match[1]));
}

/**
 * Every public `exports` subpath must be gated for neutrality or excluded BY NAME.
 *
 * The neutrality gate's entry list is hand-maintained, and until this claim
 * existed no gate covered it: a new package or a new subpath was silently
 * ungated, and an omission is indistinguishable from a decision to skip it. The
 * two lists together are the decision record, so this asserts they stay
 * complete against the manifests rather than asserting anything about
 * neutrality itself.
 *
 * The manifests' OWN targets are what get looked up, never a guess at where a
 * key's barrel lives, so a moved barrel cannot satisfy this by accident.
 *
 * `/node` subpaths are out of scope: the framework's server-only boundary puts
 * anything Node-bound behind exactly that spelling, so they are Node-only by
 * contract rather than by an entry-level judgement, and listing them would be an
 * inventory with no decision in it.
 */
function checkNeutralityEntryCoverage() {
   const source = readFileSync(join(REPO_ROOT, 'scripts/check-neutral-bundles.mjs'), 'utf-8');
   const gated = neutralityEntries(source, 'TARGETS');
   const excluded = neutralityEntries(source, 'NOT_GATED');
   if (gated === undefined || excluded === undefined) {
      return ['scripts/check-neutral-bundles.mjs: could not read its TARGETS / NOT_GATED arrays, so their coverage cannot be checked.'];
   }
   if (gated.size === 0 || excluded.size === 0) {
      return [
         'scripts/check-neutral-bundles.mjs: TARGETS or NOT_GATED read as empty, so every "accounted for" verdict below would be vacuous.'
      ];
   }

   const problems = [];
   for (const directory of expandWorkspaceEntry('packages/*')) {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8'));
      for (const [key, value] of Object.entries(manifest.exports ?? {})) {
         if (key.startsWith('./lib/') || /(^|\/)node$/.test(key)) {
            continue;
         }
         const target = typeof value === 'string' ? value : value.default;
         if (target === undefined) {
            problems.push(`${manifest.name}: the \`${key}\` export has no \`default\` condition, so its artefact cannot be identified.`);
            continue;
         }
         const entry = `${repoRelative(directory)}/${target.replace(/^\.\//, '')}`;
         if (!gated.has(entry) && !excluded.has(entry)) {
            problems.push(
               `${manifest.name}: the \`${key}\` export (\`${entry}\`) is in neither TARGETS nor NOT_GATED in ` +
                  'scripts/check-neutral-bundles.mjs, so it is ungated for browser-neutrality with no recorded reason.'
            );
         }
      }
   }
   return problems;
}

async function main() {
   const { ESLint } = await import('eslint');
   const eslint = new ESLint({ cwd: REPO_ROOT });
   const packages = listWorkspacePackages();

   const problems = await selfTest(eslint, packages);
   if (problems.length > 0) {
      report(problems);
   }

   // eslint: the phantom-dependency rule must govern every package's `src`.
   for (const { dir, name } of packages) {
      if (!(await hasExtraneousDependencyRule(eslint, join(dir, 'src/__glob-probe__.ts')))) {
         problems.push(
            `${name} (${repoRelative(dir)}/src): 'import/no-extraneous-dependencies' is not configured. ` +
               'Widen the `files` globs in eslint.config.js — an unmatched glob leaves the rule UNSET, which `--max-warnings 0` reads as clean.'
         );
      }
   }

   // eslint: and every package's TEST tree, under the other option set. Asserted
   // separately from `src` because the two are different blocks with different
   // options, so one covering a package says nothing about the other — and the
   // test-tree half is the one with no backstop, since the Playwright tiers that
   // depend on it are outside `check`.
   for (const { dir, name } of packages) {
      if (!existsSync(join(dir, 'test'))) {
         continue;
      }
      const options = await extraneousDependencyOptions(eslint, join(dir, 'test/__glob-probe__.ts'));
      if (options === undefined) {
         problems.push(
            `${name} (${repoRelative(dir)}/test): 'import/no-extraneous-dependencies' is not configured, so a test importing an undeclared package is reported by nothing.`
         );
      } else if (!Array.isArray(options.packageDir) || options.packageDir.length < 2) {
         problems.push(
            `${name} (${repoRelative(dir)}/test): the rule is configured without a two-entry \`packageDir\`. It must name the package AND the repo root, or every root devDependency a test uses reads as extraneous.`
         );
      }
   }

   // eslint: every package with a tsconfig must be named by the resolver.
   const projectGlobs = await resolverProjectGlobs(eslint, join(REPO_ROOT, 'packages/core/src/__glob-probe__.ts'));
   const resolvedProjects = new Set(
      projectGlobs.flatMap(glob => expandWorkspaceEntry(glob.replace(/\/tsconfig\.json$/, ''))).map(repoRelative)
   );
   for (const { dir, name } of packages) {
      if (existsSync(join(dir, 'tsconfig.json')) && !resolvedProjects.has(repoRelative(dir))) {
         problems.push(
            `${name} (${repoRelative(dir)}/tsconfig.json): not reached by the import resolver's \`project\` globs in eslint.config.js.`
         );
      }
   }

   // vitest: every package with a suite config must be a root project.
   //
   // Loaded through vite rather than by `await import`, and that is a floor
   // constraint rather than a preference: the config is TypeScript, and Node
   // strips types unflagged only from 22.18, where `engines.node` declares
   // 22.13 — so a direct import throws ERR_UNKNOWN_FILE_EXTENSION on the
   // oldest version this repo supports, which is exactly what `.nvmrc` pins CI
   // to. `loadConfigFromFile` bundles the config with esbuild first, so it is
   // version-independent, and it keeps this reading the tool's own answer
   // rather than a second parser of ours.
   const { loadConfigFromFile } = await import('vite');
   const loadedVitestConfig = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(REPO_ROOT, 'vitest.config.ts'));
   const projectPatterns = loadedVitestConfig?.config?.test?.projects ?? [];
   const discovered = new Set(
      projectPatterns.flatMap(pattern => expandWorkspaceEntry(pattern.replace(/\/vitest\.config\.ts$/, ''))).map(repoRelative)
   );
   for (const { dir, name } of packages) {
      if (existsSync(join(dir, 'vitest.config.ts')) && !discovered.has(repoRelative(dir))) {
         problems.push(
            `${name} (${repoRelative(dir)}/vitest.config.ts): not matched by any \`projects\` glob in vitest.config.ts, ` +
               'so its suites are absent from the root workspace.'
         );
      }
   }

   problems.push(
      ...checkRootTsconfigReferences(),
      ...checkTurboInputs(),
      ...checkIgnorePatterns(),
      ...checkSnippetDiscovery(),
      ...checkNeutralityEntryCoverage()
   );

   if (problems.length > 0) {
      report(problems);
   }
   console.log(
      `✓ all ${packages.length} workspace packages are reached by the globs that claim to cover them ` +
         '(eslint rules + resolver, vitest projects, root tsconfig references, turbo inputs, ignore patterns, README discovery, neutrality entries)'
   );
}

function report(problems) {
   console.error('✗ a glob no longer covers the packages it claims to:\n');
   for (const problem of problems) {
      console.error(`  - ${problem}`);
   }
   console.error('\nA `*` does not cross a separator, so a layout change one level deep silently empties a glob.');
   process.exit(1);
}

await main();
