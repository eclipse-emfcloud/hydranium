#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Coverage gate for the gate itself: one leg runs everything and every other
 * leg runs less, and this is what keeps that a decision rather than a drift.
 *
 * The gate has two halves and each is split the same way. `check:turbo` names
 * every turbo target and `check:turbo:platform` the subset every leg runs;
 * `check:rest:once` and `check:rest:platform` partition the tail. The
 * difference is not free to leave implicit: a clause added to the full side
 * and forgotten on the other silently stops running on a platform, and nothing
 * anywhere reports it — the leg is green because it ran what it was asked to.
 * That is the same failure shape the nine clauses that once drifted out of CI
 * had, and the reason the gate is otherwise kept as one command.
 *
 * The two halves are asserted differently, because they can fail differently.
 * The TAIL is spelled as `once` then `platform`, so its union holds by
 * construction and only disjointness and assembly can go wrong. The TARGETS
 * are two independent lists, so theirs cannot — which is why they need a
 * declared exemption per omitted target, and the tail does not.
 *
 * So the target difference must be DECLARED, with a reason, and this asserts
 * the two lists agree in both directions:
 * - a target in neither the platform subset nor `EXCLUDED` is an undecided
 *   target, and fails here rather than quietly skipping a platform
 * - an `EXCLUDED` entry naming a target that no longer exists is a stale
 *   exemption, and fails rather than sitting there looking load-bearing
 * - a platform target absent from the full set means the two scripts have
 *   diverged on what a target even is
 *
 * The reason is a required FIELD rather than a comment, because a regex over
 * prose is never provably complete and an exemption whose justification nobody
 * can find is one nobody can retire.
 *
 * It also asserts that `check` and `check:platform` are assembled from those
 * halves and nothing else, because a leg that lost a half to a typo would run
 * a shorter chain and still exit 0.
 *
 * It SELF-TESTS, because a comparison that has stopped discriminating reports
 * universal agreement and reads exactly like a clean repository.
 *
 * Usage: node scripts/check-gate-targets.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Targets the windows leg deliberately does not run, and why.
 *
 * The bar for an entry is that the target CANNOT reach a different verdict on
 * windows, so that running it there buys a second identical answer rather than
 * coverage. Slowness alone is not a reason: the windows leg exists because this
 * stack diverges on path spelling and URI identity, and a target that could
 * observe that divergence belongs on it however long it takes.
 */
const EXCLUDED = {
   lint: 'eslint reads file content and nothing else. `.gitattributes` pins every text file to `eol=lf`, so both legs lint identical bytes, and the one resolution difference that exists runs the safe way: an import whose spelling disagrees with the filename resolves on a case-insensitive filesystem and FAILS on ubuntu, so the ubuntu leg is the strictly stricter of the two.',
   'typecheck:test':
      'tsc, for the same reason as lint and with the same asymmetry — a wrongly-cased module specifier is an error on ubuntu and not on windows, so the leg that can catch it is the one still running this.'
};

/** The targets one `turbo run ...` script names, in order. */
function turboTargetsOf(script, scriptName) {
   const match = /^turbo run (.+)$/.exec(script.trim());
   if (!match) {
      throw new Error(`\`${scriptName}\` is no longer a bare \`turbo run\` invocation, so its targets cannot be read: ${script}`);
   }
   const targets = match[1].trim().split(/\s+/);
   const flag = targets.find(target => target.startsWith('-'));
   if (flag) {
      throw new Error(`\`${scriptName}\` passes \`${flag}\`; this gate reads targets positionally and would treat it as one.`);
   }
   return targets;
}

/**
 * Compare one full target list against one platform subset and its exemptions.
 *
 * Pure, and separated from the manifest it is normally fed, so the self-test
 * below can drive it with inputs that must fail.
 */
function disagreements(full, platform, excluded) {
   const problems = [];
   const fullSet = new Set(full);
   const platformSet = new Set(platform);

   for (const target of platform) {
      if (!fullSet.has(target)) {
         problems.push(`\`${target}\` runs on the platform leg but is not in the full target list.`);
      }
   }
   for (const target of full) {
      if (platformSet.has(target)) {
         continue;
      }
      if (!(target in excluded)) {
         problems.push(
            `\`${target}\` runs on ubuntu but not on windows, and no reason is declared for that. Add it to \`check:turbo:platform\`, or give it an \`EXCLUDED\` entry saying why windows cannot reach a different verdict.`
         );
      }
   }
   for (const [target, reason] of Object.entries(excluded)) {
      if (!fullSet.has(target)) {
         problems.push(`\`${target}\` is excluded from the windows leg but is no longer a target at all; drop the exemption.`);
      } else if (platformSet.has(target)) {
         problems.push(`\`${target}\` is excluded from the windows leg and also run by it; the two disagree.`);
      }
      if (typeof reason !== 'string' || reason.trim().length === 0) {
         problems.push(`\`${target}\` is excluded with no reason given.`);
      }
   }
   return problems;
}

/**
 * Drive the comparison with inputs whose verdict is known.
 *
 * Every case but the last MUST be reported. A build of this script that agreed
 * with everything would pass the real check silently, which is the one failure
 * a comparison cannot report about itself.
 */
function selfTest() {
   const cases = [
      { why: 'a target in neither the subset nor the exemptions', full: ['a', 'b'], platform: ['a'], excluded: {}, expectProblem: true },
      {
         why: 'an exemption for a target that no longer exists',
         full: ['a'],
         platform: ['a'],
         excluded: { b: 'gone' },
         expectProblem: true
      },
      { why: 'a platform target missing from the full list', full: ['a'], platform: ['a', 'b'], excluded: {}, expectProblem: true },
      { why: 'an exemption with an empty reason', full: ['a', 'b'], platform: ['a'], excluded: { b: '  ' }, expectProblem: true },
      {
         why: 'a subset and exemptions that account for everything',
         full: ['a', 'b'],
         platform: ['a'],
         excluded: { b: 'reason' },
         expectProblem: false
      }
   ];
   for (const probe of cases) {
      const found = disagreements(probe.full, probe.platform, probe.excluded).length > 0;
      if (found !== probe.expectProblem) {
         console.error(`check-gate-targets self-test failed: ${probe.why} should ${probe.expectProblem ? '' : 'not '}have been reported.`);
         process.exit(1);
      }
   }
}

/**
 * The script names one gate hands to the gate runner, in order.
 *
 * The two gates are spelled as an argument list rather than as an `&&` chain
 * because a chain has no way to SAY it failed: npm suppresses its own message
 * for a failed `run`, so a chain's verdict is its exit code alone and a capture
 * of a red run reads green. What matters HERE is only that the assembly stays
 * written in the manifest, in a form this can read back — a clause list that
 * moved into the runner would sit where nothing compares it against the halves.
 */
function gateClausesOf(script, scriptName) {
   const match = /^node scripts\/run-gate\.mjs\s+(.+)$/.exec(script.trim());
   if (!match) {
      throw new Error(
         `\`${scriptName}\` is no longer \`node scripts/run-gate.mjs <script>...\`, so the halves it assembles cannot be read: ${script}`
      );
   }
   const named = match[1].trim().split(/\s+/);
   const flag = named.find(clause => clause.startsWith('-'));
   if (flag) {
      throw new Error(`\`${scriptName}\` passes \`${flag}\`; this gate reads clauses positionally and would treat it as one.`);
   }
   return named;
}

/** The script names one `&&` chain of `npm run` clauses invokes, in order. */
function clausesOf(script, scriptName) {
   return script.split('&&').map(clause => {
      const match = /^\s*npm run (?:--if-present )?([\w:-]+)\s*$/.exec(clause);
      if (!match) {
         throw new Error(`\`${scriptName}\` holds a clause this gate cannot read as \`npm run <script>\`: ${clause.trim()}`);
      }
      return match[1];
   });
}

/**
 * The tail is PARTITIONED, not subsetted, and that is the difference worth
 * asserting.
 *
 * `check:rest` is spelled as its two halves rather than as a list, so the union
 * holds by construction and only the disjointness and the membership can go
 * wrong. Naming a clause in both halves would run it twice on the reference leg
 * — cheap, but it means the two lists disagree about what the clause is for,
 * and the next reader cannot tell which spelling was intended.
 */
function tailDisagreements(rest, once, platform) {
   const problems = [];
   const expected = ['check:rest:once', 'check:rest:platform'];
   if (rest.join(' ') !== expected.join(' ')) {
      problems.push(
         `\`check:rest\` should invoke exactly \`${expected.join('\` then \`')}\`, so that neither half can be dropped without showing here. It invokes: ${rest.join(', ')}.`
      );
   }
   for (const clause of once) {
      if (platform.includes(clause)) {
         problems.push(`\`${clause}\` is in both halves of the tail, so the reference leg runs it twice.`);
      }
   }
   if (once.length === 0 || platform.length === 0) {
      problems.push('One half of the tail is empty; a partition with nothing on one side asserts nothing.');
   }
   return problems;
}

selfTest();

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const full = turboTargetsOf(manifest.scripts['check:turbo'], 'check:turbo');
const platform = turboTargetsOf(manifest.scripts['check:turbo:platform'], 'check:turbo:platform');
const tailOnce = clausesOf(manifest.scripts['check:rest:once'], 'check:rest:once');
const tailPlatform = clausesOf(manifest.scripts['check:rest:platform'], 'check:rest:platform');

const problems = [
   ...disagreements(full, platform, EXCLUDED),
   ...tailDisagreements(clausesOf(manifest.scripts['check:rest'], 'check:rest'), tailOnce, tailPlatform)
];

// The two gates must be assembled from the halves and nothing else, or a leg
// can lose a half to a typo and still exit 0 on a shorter chain.
const assembled = { check: 'check:turbo check:rest', 'check:platform': 'check:turbo:platform check:rest:platform' };
for (const [name, expected] of Object.entries(assembled)) {
   const actual = gateClausesOf(manifest.scripts[name], name).join(' ');
   if (actual !== expected) {
      problems.push(
         `\`${name}\` should be \`${expected.split(' ').join('\` then \`')}\`, and is \`${actual.split(' ').join('\` then \`')}\`.`
      );
   }
}

if (problems.length > 0) {
   console.error('The full gate and the per-platform gate do not account for each other:\n');
   for (const problem of problems) {
      console.error(`  - ${problem}`);
   }
   console.error('');
   process.exit(1);
}

console.log(
   `check:gate-targets: ${platform.length}/${full.length} turbo target(s) and ${tailPlatform.length}/${tailOnce.length + tailPlatform.length} tail clause(s) run on every platform.`
);
