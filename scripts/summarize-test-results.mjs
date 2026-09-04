/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Renders the JUnit files the test tiers emit into the GitHub job summary.
//
// The reports were already being collected as an ARTEFACT, which is a zip
// nobody downloads to answer "what failed" — so a red run cost a log read or a
// download to learn a test's NAME. This turns the same data into a table on the
// run's summary tab.
//
// It reads only what is on disk and asserts nothing, so it is a REPORTER rather
// than a gate: it must never fail a build over its own parsing. What it does
// refuse to do is print an empty table — finding no reports at all is reported
// LOUDLY, because a silent empty summary reads exactly like a green run with
// nothing to say.
//
// Writes to `$GITHUB_STEP_SUMMARY` when set, stdout otherwise, so it is
// runnable locally against a real CI artefact.
//
// Usage: node scripts/summarize-test-results.mjs [rootDir]

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const searchRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

/** How many of the slowest cases to name. */
const SLOWEST = 10;

/**
 * Every `.xml` at or below `dir`, which is entered once a `test-results/` has
 * been found.
 *
 * RECURSIVE, and not by preference: a tier whose config runs twice gives each
 * invocation its own subdirectory, because Playwright clears `outputDir` on
 * start and a shared one means the second run deletes the first's report. A
 * flat read of `test-results/` would then miss both.
 */
function collectXml(dir, found) {
   for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectXml(full, found);
      else if (entry.name.endsWith('.xml')) found.push(full);
   }
}

/**
 * Every XML report under a `test-results/` directory, skipping trees that
 * cannot hold one.
 */
function findReports(dir, found = []) {
   let entries;
   try {
      entries = readdirSync(dir, { withFileTypes: true });
   } catch {
      return found;
   }
   for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib' || entry.name === 'out') continue;
      const full = join(dir, entry.name);
      if (entry.name === 'test-results') {
         collectXml(full, found);
         continue;
      }
      findReports(full, found);
   }
   return found;
}

/**
 * The `<testcase>` entries of one report.
 *
 * `\sname=` rather than `name=`, because `[^>]*` is greedy and would otherwise
 * match inside `classname="` and report every case under its SPEC FILE instead
 * of its title — which is what happened the first time this was done by hand.
 */
function parseCases(xml) {
   const cases = [];
   for (const match of xml.matchAll(/<testcase\b([^>]*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attributes = match[1];
      const body = match[3] ?? '';
      const name = /\sname="([^"]*)"/.exec(attributes)?.[1] ?? '(unnamed)';
      const seconds = Number(/\stime="([0-9.]+)"/.exec(attributes)?.[1] ?? '0');
      cases.push({
         name: decodeXml(name),
         seconds,
         failed: /<(failure|error)\b/.test(body),
         skipped: /<skipped\b/.test(body)
      });
   }
   return cases;
}

function decodeXml(text) {
   return text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&#10;', ' ')
      .replaceAll('&amp;', '&');
}

/** `packages/core` or `examples/order-flow/browser`, from the report's path. */
function packageOf(reportPath) {
   const parts = relative(searchRoot, reportPath).split(sep);
   return parts.slice(0, parts.indexOf('test-results')).join('/') || '(root)';
}

const reports = findReports(searchRoot);
const lines = [];

if (reports.length === 0) {
   lines.push('## Test results', '', '> **No JUnit reports were found.** Either no tier ran, or none is configured to');
   lines.push('> emit one — an empty summary here is not a clean run.');
} else {
   // Keyed by package, not by report: a tier that runs its config twice emits
   // two files for one package, and a row each would read as two packages.
   const byPackage = new Map();
   for (const report of reports) {
      const name = packageOf(report);
      const cases = (byPackage.get(name) ?? []).concat(parseCases(readFileSync(report, 'utf8')));
      byPackage.set(name, cases);
   }

   const perPackage = [...byPackage]
      .map(([name, cases]) => ({
         name,
         cases,
         failed: cases.filter(one => one.failed),
         skipped: cases.filter(one => one.skipped).length,
         seconds: cases.reduce((total, one) => total + one.seconds, 0)
      }))
      .sort((left, right) => right.seconds - left.seconds);

   const all = perPackage.flatMap(entry => entry.cases);
   const failures = perPackage.flatMap(entry => entry.failed.map(one => ({ ...one, pkg: entry.name })));

   lines.push('## Test results', '');
   lines.push(
      `**${all.length}** cases across **${perPackage.length}** packages — ` +
         `**${failures.length}** failed, **${all.filter(one => one.skipped).length}** skipped.`,
      ''
   );

   if (failures.length > 0) {
      lines.push('### Failures', '');
      for (const failure of failures) lines.push(`- \`${failure.pkg}\` — ${failure.name}`);
      lines.push('');
   }

   lines.push('<details><summary>Per package</summary>', '');
   lines.push('| Package | Cases | Failed | Skipped | Time |', '| --- | ---: | ---: | ---: | ---: |');
   for (const entry of perPackage) {
      lines.push(
         `| \`${entry.name}\` | ${entry.cases.length} | ${entry.failed.length} | ${entry.skipped} | ${entry.seconds.toFixed(1)}s |`
      );
   }
   lines.push('', '</details>', '');

   // The slowest cases, because a timeout is the failure this data prevents:
   // the console reporter totals a package and names no test, so without this
   // the next slow test is found by it going red.
   const slowest = [...all].sort((left, right) => right.seconds - left.seconds).slice(0, SLOWEST);
   lines.push(`<details><summary>Slowest ${slowest.length}</summary>`, '');
   lines.push('| Time | Test |', '| ---: | --- |');
   for (const one of slowest) lines.push(`| ${one.seconds.toFixed(2)}s | ${one.name} |`);
   lines.push('', '</details>');
}

const rendered = lines.join('\n') + '\n';
const target = process.env.GITHUB_STEP_SUMMARY;
if (target) {
   appendFileSync(target, rendered);
   console.log(`wrote ${reports.length} report(s) to the job summary`);
} else {
   process.stdout.write(rendered);
}
