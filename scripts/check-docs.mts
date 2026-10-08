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
 * The documentation gate: relative links and anchors resolve, every page is
 * reachable from an index, and versions, dates, measurements, history and line
 * references do not spread through prose.
 *
 * Rot and unreachable pages are held by a ratchet, not a ban: the baseline
 * records today's count per page and category, a rise fails, and a fall fails
 * until the baseline is lowered with `--write`, so the numbers only go down.
 *
 * Usage: node scripts/check-docs.mts [--write]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = 'scripts/check-docs-baseline.json';

/** Top-level trees that hold templates, tooling or private notes rather than documentation. */
const OUT_OF_SCOPE_TREES = new Set(['.changeset', '.github', '.claude', 'internal']);

/** Where a reader starts; a page neither reaches is invisible. */
const INDEXES = ['README.md', 'docs/README.md'];

/** Pages whose text is not ours to hold to the rot policy: Eclipse boilerplate and licence attribution. */
const ROT_EXEMPT = new Set(['CODE_OF_CONDUCT.md', 'NOTICE.md']);

/**
 * The one page that quotes versions, so every other page links to it. The
 * scaffold README is exempt as a whole because `check:init-provenance` holds it
 * to what `init` emits.
 */
const VERSION_HOME = 'docs/adopting/requirements.md';
const SCAFFOLD_README = 'examples/bookstore/server/README.md';

type Category = 'unreachable' | 'version' | 'date' | 'size' | 'timing' | 'history' | 'line-reference';

const ROT_PATTERNS: { category: Exclude<Category, 'unreachable'>; pattern: RegExp; remedy: string }[] = [
   {
      category: 'version',
      pattern: /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.<>]+)?\b|(?:[@^~]|\b(?:Node|npm|vitest|Langium|Theia|TypeScript) )\d+(?:\.\d+)?(?:\.x)?\b/g,
      remedy: `link to ${VERSION_HOME}, or name the manifest field`
   },
   { category: 'date', pattern: /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/g, remedy: 'drop it; git log holds when' },
   {
      category: 'size',
      pattern: /\b\d+(?:\.\d+)?\s?(?:[kKMGT]i?B|bytes)\b/g,
      remedy: 'drop it, or record it with how it was taken in the performance baseline'
   },
   {
      category: 'timing',
      pattern:
         /~?\b\d+(?:\.\d+)?\s?(?:ms|secs?|seconds?|minutes?|mins?|hours?)\b|~?\b\d+(?:\.\d+)? s\b|~?\b\d{1,2}(?:\.\d+)?s\b|\b(?:one|two|three|five|ten|twenty|thirty) (?:seconds|minutes)\b/g,
      remedy: 'describe the behaviour; name the constant if the reader sets it'
   },
   {
      category: 'history',
      pattern:
         /\b(?:(?:we|it|this|they|that) used to|used to be|until now|earlier version|at one point|(?:was|were) (?:renamed|removed|replaced))\b/gi,
      remedy: 'state the current rule and its reason; the story belongs in the commit'
   },
   {
      category: 'line-reference',
      pattern: /\b[\w.-]+\.(?:m?ts|tsx|cts|m?js|cjs|json|ya?ml|langium|md):\d+|#L\d+\b/g,
      remedy: 'name what lives there instead'
   }
];

const FENCE = /^\s*(?:```|~~~)/;
const CODE_SPAN = /`+[^`]*`+/g;
const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;
const HTML_TARGET = /(?:href|src)="([^"]+)"/g;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const HTML_ANCHOR = /<a\s+(?:id|name)="([^"]+)"/g;

/** Lines outside fenced code, with their 1-based numbers. */
function proseLines(text: string): { line: number; text: string }[] {
   const lines: { line: number; text: string }[] = [];
   let inFence = false;
   text.split('\n').forEach((line, index) => {
      if (FENCE.test(line)) {
         inFence = !inFence;
      } else if (!inFence) {
         lines.push({ line: index + 1, text: line });
      }
   });
   return lines;
}

/** GitHub's heading slug: links and markup reduced to their text, punctuation dropped, spaces to hyphens. */
export function slugify(heading: string): string {
   return heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
}

/** Every anchor a page offers, with GitHub's `-1`, `-2` suffixes on repeated headings. */
export function anchorsOf(text: string): Set<string> {
   const anchors = new Set<string>();
   const seen = new Map<string, number>();
   for (const { text: line } of proseLines(text)) {
      for (const match of line.matchAll(HTML_ANCHOR)) anchors.add(match[1].toLowerCase());
      const heading = HEADING.exec(line);
      if (!heading) continue;
      const base = slugify(heading[1]);
      const count = seen.get(base) ?? 0;
      anchors.add(count === 0 ? base : `${base}-${count}`);
      seen.set(base, count + 1);
   }
   return anchors;
}

/** Relative link targets in prose; code spans and fenced code are text, not links. */
export function linksOf(text: string): { line: number; target: string }[] {
   const links: { line: number; target: string }[] = [];
   for (const { line, text: raw } of proseLines(text)) {
      const prose = raw.replace(CODE_SPAN, '');
      const targets = [...prose.matchAll(INLINE_LINK)].map(match => match[1]);
      const definition = REFERENCE_DEFINITION.exec(prose);
      if (definition) targets.push(definition[1]);
      targets.push(...[...prose.matchAll(HTML_TARGET)].map(match => match[1]));
      for (const target of targets) {
         if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) links.push({ line, target });
      }
   }
   return links;
}

/** Rot hits per category on one page, minus the exemptions the policy grants it. */
export function rotCounts(file: string, text: string, peers: readonly string[] = []): Map<Category, number> {
   const counts = new Map<Category, number>();
   if (ROT_EXEMPT.has(file) || file === SCAFFOLD_README) return counts;
   for (const { text: line } of proseLines(text)) {
      for (const { category, pattern } of ROT_PATTERNS) {
         if (category === 'version' && (file === VERSION_HOME || peers.some(peer => line.includes(`\`${peer}\``)))) continue;
         const hits = line.match(pattern)?.length ?? 0;
         if (hits > 0) counts.set(category, (counts.get(category) ?? 0) + hits);
      }
   }
   return counts;
}

type Counts = Record<string, Partial<Record<Category, number>>>;

/** Where the counts disagree with the baseline; a fall is a failure too, so the baseline only moves down. */
export function compareToBaseline(current: Counts, baseline: Counts): { file: string; category: Category; was: number; now: number }[] {
   const differences = [];
   const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
   for (const file of files) {
      const categories = new Set([...Object.keys(current[file] ?? {}), ...Object.keys(baseline[file] ?? {})]) as Set<Category>;
      for (const category of categories) {
         const was = baseline[file]?.[category] ?? 0;
         const now = current[file]?.[category] ?? 0;
         if (was !== now) differences.push({ file, category, was, now });
      }
   }
   return differences.sort((left, right) => left.file.localeCompare(right.file) || left.category.localeCompare(right.category));
}

/** Pages no index reaches by following links. */
export function unreachable(pages: readonly string[], linksFrom: (page: string) => readonly string[]): string[] {
   const reached = new Set(INDEXES.filter(index => pages.includes(index)));
   const queue = [...reached];
   for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
      for (const next of linksFrom(page)) {
         if (pages.includes(next) && !reached.has(next)) {
            reached.add(next);
            queue.push(next);
         }
      }
   }
   return pages.filter(page => !reached.has(page));
}

/** A relative target resolved against its page, as a repo path; a directory resolves to its README if it has one. */
function resolveTarget(page: string, target: string): { path: string; anchor: string; exists: boolean } {
   const [pathPart, anchor = ''] = target.split('#', 2);
   if (pathPart === '') return { path: page, anchor, exists: true };
   let path = normalize(join(dirname(page), decodeURI(pathPart)));
   const absolute = join(REPO_ROOT, path);
   if (!existsSync(absolute)) return { path, anchor, exists: false };
   if (statSync(absolute).isDirectory() && existsSync(join(absolute, 'README.md'))) path = join(path, 'README.md');
   return { path, anchor, exists: true };
}

/** Tracked and new markdown pages in scope, so a page is checked before it is committed. */
function listPages(): string[] {
   const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8'
   });
   return [...new Set(stdout.split('\0').filter(Boolean))]
      .filter(file => !OUT_OF_SCOPE_TREES.has(file.split('/')[0]))
      .filter(file => existsSync(join(REPO_ROOT, file)))
      .sort();
}

/** A package README's declared peers, whose ranges `check:readmes` already holds to the manifest. */
function peersOf(page: string): string[] {
   const match = /^packages\/[^/]+\/README\.md$/.exec(page);
   if (!match) return [];
   const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dirname(page), 'package.json'), 'utf-8')) as {
      peerDependencies?: Record<string, string>;
   };
   return Object.keys(manifest.peerDependencies ?? {});
}

/** Fabricated pages that must be classified one way, so a gate that stopped detecting cannot read as a clean tree. */
function runSelfTests(): boolean {
   const probes: { name: string; passed: boolean }[] = [
      { name: 'a repeated heading gets a numbered anchor', passed: anchorsOf('# A\n## A\n').has('a-1') },
      { name: 'an em dash leaves a double hyphen', passed: anchorsOf('## Adopting — I build\n').has('adopting--i-build') },
      { name: 'a link inside a code span is not a link', passed: linksOf('see `[x](missing.md)`\n').length === 0 },
      { name: 'a link inside fenced code is not a link', passed: linksOf('```\n[x](missing.md)\n```\n').length === 0 },
      { name: 'a URL is not a relative link', passed: linksOf('[x](https://example.org/a.md)\n').length === 0 },
      { name: 'a relative link is found', passed: linksOf('[x](../a.md#b)\n')[0]?.target === '../a.md#b' },
      { name: 'a reference definition is found', passed: linksOf('[x]: ../a.md\n')[0]?.target === '../a.md' },
      { name: 'a footnote is not a link', passed: linksOf('[^1]: Capitalized terms\n').length === 0 },
      ...ROT_PATTERNS.map(({ category }) => ({
         name: `a ${category} hit is counted`,
         passed: (rotCounts('docs/probe.md', ROT_FIRES[category]).get(category) ?? 0) > 0
      })),
      {
         name: 'nothing is counted in fenced code',
         passed: rotCounts('docs/probe.md', `\`\`\`\n${Object.values(ROT_FIRES).join('\n')}\n\`\`\`\n`).size === 0
      },
      { name: 'the version home may quote versions', passed: !rotCounts(VERSION_HOME, ROT_FIRES.version).has('version') },
      {
         name: 'a peer line may quote its range',
         passed: !rotCounts('packages/x/README.md', '| `@scope/peer` | `^1.2.3` |', ['@scope/peer']).has('version')
      },
      { name: 'ordinary prose is not counted', passed: rotCounts('docs/probe.md', ROT_SILENT).size === 0 },
      {
         name: 'a rise, a fall and a new page all differ from the baseline',
         passed: compareToBaseline({ a: { date: 2 }, b: { size: 1 }, c: { timing: 1 } }, { a: { date: 1 }, b: { size: 2 } }).length === 3
      },
      { name: 'equal counts do not differ', passed: compareToBaseline({ a: { date: 1 } }, { a: { date: 1 } }).length === 0 },
      {
         name: 'a page only reachable through another page is reachable; an unlinked one is not',
         passed:
            unreachable(['README.md', 'a.md', 'b.md', 'c.md'], page => ({ 'README.md': ['a.md'], 'a.md': ['b.md'] })[page] ?? []).join() ===
            'c.md'
      }
   ];
   let broken = false;
   for (const probe of probes) {
      if (!probe.passed) {
         broken = true;
         console.error(`✗ SELF-TEST FAILED: ${probe.name}`);
      }
   }
   if (!broken) console.log(`✓ ${probes.length} self-tests`);
   return broken;
}

/** One line per category that the pattern must count. */
const ROT_FIRES: Record<Exclude<Category, 'unreachable'>, string> = {
   version: 'Declare `vscode-jsonrpc` at `9.0.0`, on Node 22.',
   date: 'Decided on 2026-06-01.',
   size: 'The page bundle is 11.7 MB.',
   timing: 'It retries after 30 s, then 20s, for up to ten seconds.',
   history: 'This used to write the whole workspace.',
   'line-reference': 'As set up in scratch-workspace.ts:88.'
};

/** Near misses that must count as nothing, each a shape the docs use for the present. */
const ROT_SILENT = [
   'The second head, see #142.',
   'The Theia app answers on localhost:3001.',
   'Import from `@hydranium/core/node`, which is Node-only.',
   'A three-step setup, run in seconds rather than minutes.',
   'The buffer used to calculate an outbound edit.',
   'Skipped when the document no longer exists.',
   'A request that 404s.'
].join('\n');

const write = process.argv.includes('--write');
let failed = runSelfTests();
// A blind pattern counts zero everywhere, and writing that would erase the ratchet.
if (failed && write) process.exit(1);

const pages = listPages();
if (!INDEXES.every(index => pages.includes(index))) {
   console.error('✗ SELF-TEST FAILED: an index page is missing from the scan, so reachability means nothing');
   process.exit(1);
}

const texts = new Map(pages.map(page => [page, readFileSync(join(REPO_ROOT, page), 'utf-8')]));
const anchorCache = new Map<string, Set<string>>();
const linkGraph = new Map<string, string[]>();
let checkedLinks = 0;
for (const [page, text] of texts) {
   const targets: string[] = [];
   for (const { line, target } of linksOf(text)) {
      checkedLinks++;
      const resolved = resolveTarget(page, target);
      if (!resolved.exists) {
         failed = true;
         console.error(`✗ ${page}:${line}: dead link ${target}`);
         continue;
      }
      targets.push(resolved.path);
      if (resolved.anchor === '' || !resolved.path.endsWith('.md')) continue;
      const targetText = texts.get(resolved.path) ?? readFileSync(join(REPO_ROOT, resolved.path), 'utf-8');
      const anchors = anchorCache.get(resolved.path) ?? anchorsOf(targetText);
      anchorCache.set(resolved.path, anchors);
      if (!anchors.has(resolved.anchor.toLowerCase())) {
         failed = true;
         console.error(`✗ ${page}:${line}: dead anchor ${target}`);
      }
   }
   linkGraph.set(page, targets);
}

const current: Counts = {};
for (const page of unreachable(pages, page => linkGraph.get(page) ?? [])) current[page] = { unreachable: 1 };
for (const [page, text] of texts) {
   for (const [category, count] of rotCounts(page, text, peersOf(page))) {
      current[page] = { ...current[page], [category]: count };
   }
}

const baselinePath = join(REPO_ROOT, BASELINE_FILE);
const baseline: Counts = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf-8')) as Counts) : {};
const differences = compareToBaseline(current, baseline);
const rises = differences.filter(difference => difference.now > difference.was);

if (write) {
   if (rises.length > 0 && existsSync(baselinePath)) {
      for (const rise of rises)
         console.error(`✗ ${rise.file}: ${rise.category} rose from ${rise.was} to ${rise.now}; --write only lowers the baseline`);
      process.exit(1);
   }
   const sorted = Object.fromEntries(
      Object.keys(current)
         .sort()
         .map(file => [file, Object.fromEntries(Object.entries(current[file]).sort())])
   );
   writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
   console.log(`✓ wrote ${BASELINE_FILE}`);
   process.exit(failed ? 1 : 0);
}

const remedies = new Map<Category, string>([
   ['unreachable', 'link it from an index or from a page an index reaches'],
   ...ROT_PATTERNS.map(({ category, remedy }) => [category, remedy] as [Category, string])
]);
for (const difference of differences) {
   failed = true;
   if (difference.now > difference.was) {
      console.error(
         `✗ ${difference.file}: ${difference.category} rose from ${difference.was} to ${difference.now} — ${remedies.get(difference.category)}`
      );
   } else {
      console.error(
         `✗ ${difference.file}: ${difference.category} fell from ${difference.was} to ${difference.now} — lower the baseline: node scripts/check-docs.mts --write`
      );
   }
}

if (!failed) {
   console.log(
      `✓ ${checkedLinks} relative link(s) resolve across ${pages.length} page(s), and no page or rot count rose above ${BASELINE_FILE}`
   );
   process.exit(0);
}
console.error('\nDocs gate failed.');
process.exit(1);
