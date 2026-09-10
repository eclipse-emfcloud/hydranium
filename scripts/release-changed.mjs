/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Publish trigger: decide whether a pushed range changed anything that can
// reach a tarball.
//
// **Why this exists.** Every merge to the default branch used to publish, so a
// commit that changed only a workflow minted a version byte-identical to the
// one before it. Measured on one day: of four releases, three came from
// commits touching nothing but `.github/**` and a root dotfile.
//
// **The list below is a SKIP list and it is short on purpose.** A path is
// inert only when it can reach no tarball at all; everything else publishes.
// That asymmetry is deliberate rather than cautious: an over-trigger costs one
// content-identical version, which is harmless, while an under-trigger
// silently withholds a real release and nothing reports it. So a file whose
// effect on the build is merely UNLIKELY — a lint config, a vitest config —
// belongs on the publishing side, and widening this list should be a one-line
// reviewable admission with a reason attached, the way each entry already
// carries one.
//
// **What backs the list is checked rather than asserted.** `--self-test`
// re-derives one half of it from the manifests: no published package's `files`
// entry may escape its own directory, so the only sources that can be packed
// are `packages/**` plus whatever the BUILD reads — the root configs, the
// lockfile, the patches — and this list names none of those. The other half is
// pinned by fixtures taken from real merges, and the fixtures are themselves
// controlled: an emptied skip list must change at least one verdict, or they
// have stopped discriminating and would report universal agreement.

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Root-level files whose only readers are git and the formatter. */
const ROOT_TOOLING = new Set(['.editorconfig', '.gitattributes', '.gitignore', '.prettierignore', '.prettierrc.js']);

/**
 * Paths that reach no tarball, each with the reason it cannot — the reason is
 * what a later reader has to re-check before trusting the entry, so it lives
 * beside the rule rather than in prose that can drift from it. This array is
 * the whole skip list: nothing classifies anything except by consulting it.
 */
const INERT = [
   {
      name: '.github/**',
      why: 'workflow and issue-template configuration, packed by no manifest',
      test: path => path.startsWith('.github/')
   },
   { name: '.vscode/**', why: 'editor configuration', test: path => path.startsWith('.vscode/') },
   { name: 'docs/**', why: 'contributor documentation; every package ships `lib` and `src` only', test: path => path.startsWith('docs/') },
   { name: 'examples/**', why: 'every example package is `private: true`', test: path => path.startsWith('examples/') },
   {
      name: '<root>/*.md',
      why: 'the repository root is not a published package, so its prose is packed nowhere',
      // Root-scoped, because npm includes a PACKAGE's README whatever its
      // `files` says — `packages/core/README.md` is in a tarball.
      test: path => !path.includes('/') && path.endsWith('.md')
   },
   {
      name: '<root> tooling dotfiles',
      why: 'formatting and vcs configuration, read by no build step',
      test: path => ROOT_TOOLING.has(path)
   }
];

/**
 * The rule that makes one changed path unable to reach a tarball, or
 * `undefined` if none does.
 *
 * It returns the RULE rather than a boolean so a skipped release can say which
 * entry decided it and why — which is the only thing that makes the skip
 * reviewable, and what keeps each entry's stated reason load-bearing instead
 * of a comment nobody reads.
 *
 * `rules` is a parameter rather than a closure over {@link INERT} so the
 * self-test can run the fixtures against an emptied list and prove they still
 * discriminate.
 */
function inertRule(path, rules = INERT) {
   return rules.find(rule => rule.test(path));
}

/** Whether a pushed range can change a tarball. Empty means publish. */
function isPublishable(paths, rules) {
   if (paths.length === 0) {
      return { publishable: true, why: 'the pushed range resolved to no changed path, so nothing rules a release out' };
   }
   const classified = paths.map(path => ({ path, rule: inertRule(path, rules) }));
   const inert = classified.filter(entry => entry.rule);
   const reaching = classified.filter(entry => !entry.rule).map(entry => entry.path);
   if (reaching.length === 0) {
      return { publishable: false, why: `all ${paths.length} changed path(s) reach no tarball`, inert };
   }
   // The inert count rides along on the publishing verdict too, so a reader
   // can tell "the filter looked and found something" from "the filter did
   // not run" — the two produce the same green release and mean different
   // things.
   return {
      publishable: true,
      why: `${reaching.length} of ${paths.length} changed path(s) can reach a tarball`,
      reaching,
      inert
   };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Real merges, with the outcome each should have had. The three that publish
 * nothing are the measured cases this filter was written for; the fourth is
 * the control that keeps it from simply answering "skip".
 */
const FIXTURES = [
   {
      name: 'a workflow change plus a root dotfile publishes nothing',
      paths: ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.prettierignore'],
      publishable: false
   },
   { name: 'a workflow change plus .gitignore publishes nothing', paths: ['.github/workflows/ci.yml', '.gitignore'], publishable: false },
   { name: 'a lone workflow change publishes nothing', paths: ['.github/workflows/ci.yml'], publishable: false },
   {
      name: 'a peer-range change across three packages publishes',
      paths: [
         '.github/workflows/theia-compat.yml',
         'package-lock.json',
         'packages/client-theia/README.md',
         'packages/client-theia/package.json',
         'packages/data-client-theia/README.md',
         'packages/data-client-theia/package.json',
         'packages/glsp-client-theia/README.md',
         'packages/glsp-client-theia/package.json'
      ],
      publishable: true
   },
   { name: "a package's README is packed and publishes", paths: ['packages/core/README.md'], publishable: true },
   { name: "the root's README is packed nowhere", paths: ['README.md'], publishable: false },
   { name: 'a doc page publishes nothing', paths: ['docs/concepts/architecture.md'], publishable: false },
   { name: 'an example source publishes nothing', paths: ['examples/order-flow/server/src/main.ts'], publishable: false },
   { name: 'a patch mutates an installed dependency and publishes', paths: ['patches/vitest+4.1.11.patch'], publishable: true },
   { name: 'the lockfile publishes', paths: ['package-lock.json'], publishable: true },
   { name: 'a root tsconfig publishes', paths: ['tsconfig.base.json'], publishable: true },
   { name: 'a release-script change publishes so the change is exercised', paths: ['scripts/release.mjs'], publishable: true },
   {
      name: 'one shippable path among inert ones publishes',
      paths: ['README.md', 'docs/x.md', 'packages/core/src/index.ts'],
      publishable: true
   },
   { name: 'an empty range publishes rather than withholding silently', paths: [], publishable: true }
];

function selfTest() {
   let failed = false;

   for (const fixture of FIXTURES) {
      const actual = isPublishable(fixture.paths).publishable;
      if (actual !== fixture.publishable) {
         console.error(`✗ self-test: ${fixture.name} — expected publishable=${fixture.publishable}, got ${actual}`);
         failed = true;
      }
   }
   if (!failed) {
      console.log(`✓ self-test: ${FIXTURES.length} cases classify as specified`);
   }

   // The fixtures' own control. With nothing on the skip list every path
   // reaches a tarball, so any fixture expecting `false` must now disagree. If
   // none does, the table has stopped exercising the skip list and its
   // agreement above means nothing.
   const moved = FIXTURES.filter(fixture => isPublishable(fixture.paths, []).publishable !== fixture.publishable);
   if (moved.length === 0) {
      console.error('✗ self-test: emptying the skip list changed no verdict, so the fixtures do not exercise it');
      failed = true;
   } else {
      console.log(`✓ self-test: emptying the skip list flips ${moved.length} case(s), so the fixtures discriminate`);
   }

   // The half of the skip list that can be re-derived. npm packs a package's
   // own `package.json`, README, LICENSE and CHANGELOG whatever `files` says,
   // and all four sit inside the package — so if no `files` entry escapes the
   // package directory either, nothing outside `packages/**` is packable and
   // the four directory prefixes above cannot become wrong without this
   // failing.
   let checked = 0;
   for (const name of readdirSync(resolve(repoRoot, 'packages'))) {
      const manifestPath = resolve(repoRoot, 'packages', name, 'package.json');
      let manifest;
      try {
         manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
         continue;
      }
      if (manifest.private) {
         continue;
      }
      checked += 1;
      for (const entry of manifest.files ?? []) {
         const pattern = entry.startsWith('!') ? entry.slice(1) : entry;
         if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
            console.error(`✗ self-test: ${name} packs \`${entry}\`, which escapes its own directory`);
            console.error("    Something outside `packages/**` is now packable, so this script's skip list may be wrong.");
            failed = true;
         }
      }
      if (!manifest.files) {
         console.error(`✗ self-test: ${name} declares no \`files\`, so npm packs its whole directory and this check proves nothing`);
         failed = true;
      }
   }
   if (checked === 0) {
      console.error('✗ self-test: no published package was read, so the packability check ran over nothing');
      failed = true;
   } else if (!failed) {
      console.log(`✓ self-test: none of ${checked} published package(s) packs anything outside its own directory`);
   }

   if (failed) {
      console.error('\nPublish-trigger self-test failed.');
      process.exit(1);
   }
   console.log('\nThe publish trigger classifies the measured cases correctly.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
   selfTest();
} else {
   const paths = readFileSync(0, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
   const verdict = isPublishable(paths);

   // Every inert path is reported with the RULE that made it inert and that
   // rule's reason — never a bare "skipped". A release that did not happen is
   // the hardest outcome to investigate after the fact, because there is no
   // failing job to open and the job log is the only place the decision was
   // ever written down.
   const report = [
      `- verdict: \`${verdict.publishable ? 'publish' : 'skip'}\` — ${verdict.why}`,
      ...(verdict.reaching ?? []).map(path => `- reaches a tarball: \`${path}\``),
      ...(verdict.inert ?? []).map(({ path, rule }) => `- inert: \`${path}\` — matched \`${rule.name}\`, ${rule.why}`)
   ];

   console.log(`publishable=${verdict.publishable}`);
   for (const line of report) {
      console.log(line.replaceAll('`', ''));
   }

   if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `publishable=${verdict.publishable}\n`);
   }
   if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${['### Publish trigger', ...report].join('\n')}\n`);
   }
   // An annotation as well as the summary, for the skip only. A skipped
   // release renders as an absence everywhere else in the UI — no failed job,
   // no red check — so without this the run's front page says nothing about
   // the one decision it made.
   if (!verdict.publishable && process.env.GITHUB_ACTIONS) {
      const rules = [...new Set((verdict.inert ?? []).map(({ rule }) => rule.name))];
      console.log(`::notice title=Release skipped::No changed path can reach a tarball (${rules.join(', ')}).`);
   }
}
