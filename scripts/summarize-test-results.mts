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
// Usage: node scripts/summarize-test-results.mts [rootDir | --self-test]

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How many of the slowest cases to name. */
const SLOWEST = 10;

interface TestCase {
   name: string;
   file: string;
   seconds: number;
   failed: boolean;
   skipped: boolean;
}

/**
 * JUnit and spawn boot reports at or below a `test-results/` directory.
 *
 * RECURSIVE, and not by preference: a tier whose config runs twice gives each
 * invocation its own subdirectory, because Playwright clears `outputDir` on
 * start and a shared one means the second run deletes the first's report. A
 * flat read of `test-results/` would then miss both.
 */
function collectReports(dir: string, found: string[]): void {
   for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectReports(full, found);
      else if (entry.name.endsWith('.xml') || /^spawn-boots-.*\.jsonl$/.test(entry.name)) found.push(full);
   }
}

/**
 * Every report under a `test-results/` directory, skipping trees that
 * cannot hold one.
 */
function findReports(dir: string, found: string[] = []): string[] {
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
         collectReports(full, found);
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
 * The attributes match lazily for the same reason at the other end: a greedy
 * match takes the `/` of a self-closing `<testcase … />`, which Mocha writes
 * for a passing case, and reads it as an open tag whose body runs to the next
 * case's `</testcase>`, dropping the cases in between and charging their
 * failure to the first.
 */
function parseCases(xml: string): TestCase[] {
   const cases: TestCase[] = [];
   for (const match of xml.matchAll(/<testcase\b([^>]*?)\s*(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attributes = match[1];
      const body = match[3] ?? '';
      const name = /\sname="([^"]*)"/.exec(attributes)?.[1] ?? '(unnamed)';
      const classname = /\sclassname="([^"]+)"/.exec(attributes)?.[1];
      // Mocha's `classname` holds the describe titles, so its `file` wins. Only
      // the basename, because the paths have no common root: Playwright's start
      // at its testDir, and Mocha's are absolute. Mocha writes `undefined` for
      // a runnable with no file, such as a root-level hook.
      const reportedFile = /\sfile="(?!undefined")([^"]+)"/.exec(attributes)?.[1];
      const file = reportedFile ?? classname ?? '(no file)';
      // A `classname` that is not the file is Mocha's describe path, which its
      // `name` leaves out.
      const describePath = reportedFile && classname && !reportedFile.endsWith(classname) ? classname : undefined;
      const seconds = Number(/\stime="([0-9.]+)"/.exec(attributes)?.[1] ?? '0');
      cases.push({
         name: decodeXml(describePath ? `${describePath} ${name}` : name),
         file: decodeXml(file).replace(/^.*[\\/]/, ''),
         seconds,
         failed: /<(failure|error)\b/.test(body),
         skipped: /<skipped\b/.test(body)
      });
   }
   return cases;
}

function decodeXml(text: string): string {
   return text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&#10;', ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_entity, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_entity, decimal: string) => String.fromCodePoint(Number(decimal)))
      .replaceAll('&amp;', '&');
}

/**
 * A test name as Markdown text: GitHub reads `<…>` as HTML and drops it, and a
 * `|` ends a table cell.
 */
function escapeMarkdown(text: string): string {
   return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('|', '\\|');
}

/** `packages/core` or `examples/order-flow/browser`, from the report's path. */
function packageOf(searchRoot: string, reportPath: string): string {
   const parts = relative(searchRoot, reportPath).split(sep);
   return parts.slice(0, parts.indexOf('test-results')).join('/') || '(root)';
}

interface BootRecord {
   serverModule: string;
   elapsedMs: number;
   budgetMs: number;
   outcome: 'initialized' | 'failed';
}

function isBootRecord(value: unknown): value is BootRecord {
   if (typeof value !== 'object' || value === null) return false;
   return (
      'serverModule' in value &&
      typeof value.serverModule === 'string' &&
      'elapsedMs' in value &&
      typeof value.elapsedMs === 'number' &&
      Number.isFinite(value.elapsedMs) &&
      value.elapsedMs >= 0 &&
      'budgetMs' in value &&
      typeof value.budgetMs === 'number' &&
      Number.isFinite(value.budgetMs) &&
      value.budgetMs > 0 &&
      'outcome' in value &&
      (value.outcome === 'initialized' || value.outcome === 'failed')
   );
}

function summarize(searchRoot: string): { rendered: string; reportCount: number } {
   const found = findReports(searchRoot);
   const reports = found.filter(report => report.endsWith('.xml'));
   const lines: string[] = [];

   if (reports.length === 0) {
      lines.push('## Test results', '', '> **No JUnit reports were found.** Either no tier ran, or none is configured to');
      lines.push('> emit one — an empty summary here is not a clean run.');
   } else {
      // Keyed by package, not by report: a tier that runs its config twice emits
      // two files for one package, and a row each would read as two packages.
      const byPackage = new Map<string, TestCase[]>();
      for (const report of reports) {
         const name = packageOf(searchRoot, report);
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

      const all = perPackage.flatMap(entry => entry.cases.map(one => ({ ...one, pkg: entry.name })));
      const failures = all.filter(one => one.failed);

      lines.push('## Test results', '');
      lines.push(
         `**${all.length}** cases across **${perPackage.length}** packages — ` +
            `**${failures.length}** failed, **${all.filter(one => one.skipped).length}** skipped.`,
         ''
      );

      if (failures.length > 0) {
         lines.push('### Failures', '');
         for (const failure of failures) lines.push(`- \`${failure.pkg}\` \`${failure.file}\` — ${escapeMarkdown(failure.name)}`);
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
      lines.push('| Time | Package | File | Test |', '| ---: | --- | --- | --- |');
      for (const one of slowest)
         lines.push(`| ${one.seconds.toFixed(2)}s | \`${one.pkg}\` | \`${one.file}\` | ${escapeMarkdown(one.name)} |`);
      lines.push('', '</details>');
   }

   const boots: (BootRecord & { pkg: string })[] = [];
   let unreadableBootRecords = 0;
   for (const report of found.filter(report => report.endsWith('.jsonl'))) {
      try {
         for (const line of readFileSync(report, 'utf8')
            .split('\n')
            .filter(line => line.trim())) {
            try {
               const record: unknown = JSON.parse(line);
               if (!isBootRecord(record)) throw new Error('Invalid boot record');
               boots.push({ ...record, pkg: packageOf(searchRoot, report) });
            } catch {
               unreadableBootRecords++;
            }
         }
      } catch {
         unreadableBootRecords++;
      }
   }
   if (boots.length > 0) {
      lines.push(
         '',
         '### Spawn boot budgets',
         '',
         `${boots.length} handshakes; showing the ${Math.min(SLOWEST, boots.length)} closest to their budget. Failed handshakes exclude teardown time.`,
         ''
      );
      lines.push('| Package | Module | Outcome | Elapsed | Budget | Used | Remaining |', '| --- | --- | --- | ---: | ---: | ---: | ---: |');
      for (const boot of boots.sort((a, b) => b.elapsedMs / b.budgetMs - a.elapsedMs / a.budgetMs).slice(0, SLOWEST)) {
         lines.push(
            `| ${escapeMarkdown(boot.pkg)} | ${escapeMarkdown(boot.serverModule).replace(/[\r\n]/g, ' ')} | ${boot.outcome} | ${(boot.elapsedMs / 1000).toFixed(2)}s | ${(boot.budgetMs / 1000).toFixed(2)}s | ${((100 * boot.elapsedMs) / boot.budgetMs).toFixed(1)}% | ${((boot.budgetMs - boot.elapsedMs) / 1000).toFixed(2)}s |`
         );
      }
   }
   if (unreadableBootRecords) lines.push('', `> Could not read ${unreadableBootRecords} spawn boot record(s) or report(s).`);

   return { rendered: lines.join('\n') + '\n', reportCount: reports.length };
}

function selfTest(): void {
   const root = mkdtempSync(join(tmpdir(), 'hydranium-test-summary-'));
   try {
      const directory = join(root, 'packages', 'one', 'test-results', 'nested');
      mkdirSync(directory, { recursive: true });
      const report = join(directory, 'spawn-boots-one.jsonl');
      writeFileSync(
         report,
         [
            JSON.stringify({ serverModule: 'slow.js', elapsedMs: 38_000, budgetMs: 120_000, outcome: 'initialized' }),
            JSON.stringify({ serverModule: 'close|budget.js', elapsedMs: 38_000, budgetMs: 45_000, outcome: 'initialized' }),
            JSON.stringify({ serverModule: 'failed.js', elapsedMs: 8_100, budgetMs: 8_000, outcome: 'failed' }),
            JSON.stringify({ serverModule: 'invalid.js', elapsedMs: 1, budgetMs: 0, outcome: 'initialized' }),
            '{truncated',
            ''
         ].join('\n')
      );
      const { rendered } = summarize(root);
      assert.ok(rendered.includes('3 handshakes'));
      assert.ok(rendered.includes('38.00s | 45.00s | 84.4% | 7.00s'));
      assert.ok(rendered.includes('38.00s | 120.00s | 31.7% | 82.00s'));
      assert.ok(rendered.includes('failed | 8.10s | 8.00s | 101.3% | -0.10s'));
      assert.ok(rendered.includes('packages/one | close\\|budget.js'));
      assert.ok(rendered.indexOf('failed.js') < rendered.indexOf('close\\|budget.js'));
      assert.ok(rendered.indexOf('close\\|budget.js') < rendered.indexOf('slow.js'));
      assert.ok(rendered.includes('Could not read 2 spawn boot record(s)'));
      assert.ok(rendered.includes('No JUnit reports were found'));
      console.log('✓ self-test: nested boot reports retain budgets, rank by usage, and skip malformed records');

      const junit = join(directory, 'junit.xml');
      writeFileSync(
         junit,
         '<testsuite><testcase name="passes" classname="one.test.ts" time="0.1"/>' +
            '<testcase name="fails" classname="one.test.ts" time="0.2"><failure>failed</failure></testcase></testsuite>'
      );
      const combined = summarize(root);
      assert.equal(combined.reportCount, 1);
      assert.ok(combined.rendered.includes('**2** cases across **1** packages — **1** failed'));
      assert.ok(combined.rendered.includes('3 handshakes'));
      rmSync(report);
      const junitOnly = summarize(root);
      assert.ok(junitOnly.rendered.includes('**2** cases across **1** packages — **1** failed'));
      assert.ok(!junitOnly.rendered.includes('Spawn boot budgets'));
      console.log('✓ self-test: JUnit reports render with and without boot reports');
   } finally {
      rmSync(root, { recursive: true, force: true });
   }
}

if (process.argv.includes('--self-test')) {
   selfTest();
} else {
   const { rendered, reportCount } = summarize(process.argv[2] ? resolve(process.argv[2]) : repoRoot);
   const target = process.env.GITHUB_STEP_SUMMARY;
   if (target) {
      appendFileSync(target, rendered);
      console.log(`wrote ${reportCount} report(s) to the job summary`);
   } else {
      process.stdout.write(rendered);
   }
}
