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
 * The mechanical half of the test-title rule. Every `describe`, `suite`,
 * `test.describe`, `it` and `test` title, with any modifier and through
 * `.each` / `.for`, is read from its literal and must not carry:
 *
 * - a dash set off by spaces, a semicolon or a colon outside backticks, in any
 *   title, since the CI summary joins the levels and a second separator reads
 *   as another level;
 * - parentheses or brackets outside backticks in a `describe` title;
 * - a `$field` in an `.each` / `.for` title, which vitest renders quoted and
 *   cuts at about 40 characters; `%s` over `[value, row]` tuples renders bare;
 * - a leading capital on a word that is not a name: an identifier declared or
 *   imported in tracked TypeScript, or an entry in {@link NAME_ALLOWLIST}.
 *
 * Interpolated parts (`${…}`, `%s`) and titles that are no literal are not
 * checked; the latter are counted. The shapes a title takes and the qualifier
 * comma stay prose rules: no parse can tell them apart.
 *
 * Usage: node scripts/check-test-titles.mts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** Leading words that are names but no identifier in this repository declares. */
const NAME_ALLOWLIST = ['Save All', 'LSP', 'Ctrl+', 'Monaco', 'GLSP', 'CRLF', 'CommentProvider'];

const TITLED = new Set(['describe', 'suite', 'it', 'test']);
const MODIFIERS = new Set([
   'describe',
   'skip',
   'only',
   'concurrent',
   'sequential',
   'todo',
   'fails',
   'each',
   'for',
   'skipIf',
   'runIf',
   'serial',
   'parallel',
   'fixme'
]);

/** Expressions that wrap a callee without changing which function it is. */
const WRAPPERS = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression']);

/** Stands in for an interpolated part, so no rule can fire on it. */
const HOLE = '\u0000';

/** The fields of an oxc AST node this script reads; anything else is walked generically. */
interface AstNode {
   type?: unknown;
   start: number;
   name?: unknown;
   computed?: unknown;
   value?: unknown;
   object?: AstNode;
   property?: AstNode;
   callee?: AstNode;
   tag?: AstNode;
   expression?: AstNode;
   arguments?: AstNode[];
   quasis?: { value: { cooked: string | null } }[];
   id?: { name?: unknown };
   local?: { name?: unknown };
   key?: { name?: unknown };
}

interface Title {
   line: number;
   kind: 'describe' | 'it';
   each: boolean;
   text: string;
}

interface Violation {
   rule: string;
   remedy: string;
}

const isAstNode = (node: unknown): node is AstNode => Boolean(node) && typeof node === 'object' && !Array.isArray(node);

function visit(node: unknown, onNode: (node: AstNode) => void): void {
   if (Array.isArray(node)) {
      for (const child of node) visit(child, onNode);
      return;
   }
   if (!isAstNode(node)) return;
   onNode(node);
   for (const [key, child] of Object.entries(node)) {
      if (key !== 'parent' && child && typeof child === 'object') visit(child, onNode);
   }
}

/** `describe.skip.each(table)` as `['describe', 'skip', 'each']`; undefined for anything else. */
function calleeChain(callee: AstNode | undefined): string[] | undefined {
   const parts: string[] = [];
   let node = callee;
   while (node) {
      if (node.type === 'MemberExpression' && !node.computed && typeof node.property?.name === 'string') {
         parts.unshift(node.property.name);
         node = node.object;
      } else if (node.type === 'CallExpression') {
         node = node.callee;
      } else if (node.type === 'TaggedTemplateExpression') {
         node = node.tag;
      } else if (WRAPPERS.has(String(node.type))) {
         node = node.expression;
      } else if (node.type === 'Identifier' && typeof node.name === 'string') {
         parts.unshift(node.name);
         return parts;
      } else {
         return undefined;
      }
   }
   return undefined;
}

function titleText(node: AstNode | undefined): string | undefined {
   if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
   if (node?.type === 'TemplateLiteral' && node.quasis) return node.quasis.map(quasi => quasi.value.cooked ?? '').join(HOLE);
   return undefined;
}

function lineIndex(text: string): (offset: number) => number {
   const starts = [0];
   for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
   return offset => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
         const middle = (low + high + 1) >> 1;
         if (starts[middle] <= offset) low = middle;
         else high = middle - 1;
      }
      return low + 1;
   };
}

/** Every literal test title in one file, and every name the file declares or imports. */
export function scanFile(fileName: string, text: string): { titles: Title[]; names: string[]; unread: number } {
   const { program } = parseSync(fileName, text);
   const lineOf = lineIndex(text);
   const titles: Title[] = [];
   const names: string[] = [];
   let unread = 0;
   visit(program, node => {
      for (const name of [node.id?.name, node.local?.name, node.type === 'Property' ? undefined : node.key?.name]) {
         if (typeof name === 'string') names.push(name);
      }
      if (node.type !== 'CallExpression') return;
      // `it.each(table)` is the callee of the call that carries the title.
      if (node.callee?.type === 'MemberExpression' && ['each', 'for', 'skipIf', 'runIf'].includes(String(node.callee.property?.name)))
         return;
      const chain = calleeChain(node.callee);
      if (!chain || !TITLED.has(chain[0]) || !chain.slice(1).every(part => MODIFIERS.has(part))) return;
      const text = titleText(node.arguments?.[0]);
      if (text === undefined) {
         unread++;
         return;
      }
      const kind = chain[0] === 'describe' || chain[0] === 'suite' || chain.includes('describe') ? 'describe' : 'it';
      titles.push({ line: lineOf(node.start), kind, each: chain.includes('each') || chain.includes('for'), text });
   });
   return { titles, names, unread };
}

/** The title with backticked code and interpolated parts blanked out. */
function prose(text: string): string {
   return text.replace(/`[^`]*`/g, HOLE).replace(/%[sdifjoO#$%]/g, HOLE);
}

function isName(text: string, names: ReadonlySet<string>): boolean {
   if (NAME_ALLOWLIST.some(entry => text.startsWith(entry))) return true;
   const word = /^[A-Za-z_$][\w$]*/.exec(text)?.[0];
   return word !== undefined && names.has(word);
}

/** The rules, as a pure function of one title, so the self-test can drive them directly. */
export function violations(title: Pick<Title, 'kind' | 'each' | 'text'>, names: ReadonlySet<string>): Violation[] {
   const found: Violation[] = [];
   const outside = prose(title.text);
   if (/\s[-–—]\s/.test(outside)) found.push({ rule: 'spaced dash', remedy: 'join the two parts into one phrase' });
   if (outside.includes(';')) found.push({ rule: 'semicolon', remedy: 'make it one statement' });
   if (outside.includes(':')) found.push({ rule: 'colon outside backticks', remedy: 'drop the label, or put the code in backticks' });
   if (title.kind === 'describe' && /[()[\]]/.test(outside)) {
      found.push({ rule: 'parentheses or brackets', remedy: 'say it in words, or put the code in backticks' });
   }
   if (title.each && /\$[\w$]/.test(title.text)) {
      found.push({ rule: '$field interpolation', remedy: 'pass [value, row] tuples and use %s, which renders the value bare' });
   }
   if (/^[A-Z]/.test(title.text) && !isName(title.text, names)) {
      found.push({ rule: 'leading capital on a word that is not a name', remedy: 'start lowercase, or add the name to NAME_ALLOWLIST' });
   }
   return found;
}

/** Fabricated sources, each pinned to the rule it must trip or to passing; a clean corpus alone cannot tell "nothing to find" from "no longer looking". */
const SELF_TESTS: { name: string; rule: string | null; source: string; noTitle?: true }[] = [
   { name: 'a spaced dash is flagged', rule: 'spaced dash', source: "it('saves the file — and closes it', () => {});" },
   { name: 'a semicolon is flagged', rule: 'semicolon', source: "it('saves the file; closes it', () => {});" },
   { name: 'a label colon is flagged', rule: 'colon outside backticks', source: "it('save: writes the file', () => {});" },
   { name: 'a bare code colon is flagged', rule: 'colon outside backticks', source: "it('opens a virtual: document', () => {});" },
   { name: 'parentheses in a describe title are flagged', rule: 'parentheses or brackets', source: "describe('Widget (pure)', () => {});" },
   {
      name: 'brackets in a test.describe title are flagged',
      rule: 'parentheses or brackets',
      source: "test.describe.serial('Widget [slow]', () => {});"
   },
   { name: 'a $field in an it.each title is flagged', rule: '$field interpolation', source: "it.each(rows)('$name saves', () => {});" },
   {
      name: 'a $field in a describe.each title is flagged',
      rule: '$field interpolation',
      source: "describe.each(rows)('$name', () => {});"
   },
   {
      name: 'a leading capital that is no name is flagged',
      rule: 'leading capital on a word that is not a name',
      source: "it('Saves the file', () => {});"
   },
   { name: 'a title through a curried modifier is read', rule: 'semicolon', source: "it.skipIf(slow)('saves; closes', () => {});" },
   {
      name: 'a title after a tagged-template table is read',
      rule: 'colon outside backticks',
      source: "it.each`\n   a\n   ${1}\n`('save: writes the file', () => {});"
   },
   {
      name: 'a $field in a tagged-template describe.each title is flagged',
      rule: '$field interpolation',
      source: "describe.each`\n   a\n   ${1}\n`('$a', () => {});"
   },
   {
      name: 'a title through a type assertion on the callee is read',
      rule: 'semicolon',
      source: "(it as typeof it)('saves; closes', () => {});\nit!.skip('saves; closes', () => {});"
   },
   { name: 'a backticked colon passes', rule: null, source: "it('opens a `virtual:` document', () => {});" },
   { name: 'parentheses in an it title pass', rule: null, source: "it('saves the file (once)', () => {});" },
   { name: 'a trailing [tag] in an it title passes', rule: null, source: "it('saves the file [domain]', () => {});" },
   { name: 'parentheses in backticks in a describe title pass', rule: null, source: "describe('`Widget.save()` retries', () => {});" },
   { name: '%s in an .each title passes', rule: null, source: "it.each(rows)('%s saves', () => {});" },
   { name: 'an interpolated part is not checked', rule: null, source: 'it(`saves ${label}`, () => {});' },
   { name: 'a leading declared name passes', rule: null, source: "class Widget {}\ndescribe('Widget save', () => {});" },
   { name: 'a leading allowlisted name passes', rule: null, source: "it('Ctrl+S saves the file', () => {});" },
   {
      name: 'a method call on a local named test is not a title',
      rule: null,
      source: "const test = { run(title: string) {} };\ntest.run('Saves; closes');",
      noTitle: true
   }
];

function runSelfTests(): boolean {
   let broken = false;
   for (const probe of SELF_TESTS) {
      const { titles, names } = scanFile('self-test.ts', probe.source);
      const fired = titles.flatMap(title => violations(title, new Set(names)).map(violation => violation.rule));
      const read = titles.length > 0 !== Boolean(probe.noTitle);
      const passed = read && (probe.rule === null ? fired.length === 0 : fired.includes(probe.rule));
      if (passed) {
         console.log(`✓ self-test: ${probe.name}`);
         continue;
      }
      broken = true;
      console.error(`✗ SELF-TEST FAILED: ${probe.name} — expected ${probe.rule ?? 'nothing'}, got ${fired.join(', ') || 'nothing'}`);
   }
   return broken;
}

/** Tracked and new-but-untracked sources, so a bad title is caught before it is committed. */
function listSources(): string[] {
   const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024
   });
   return stdout.split('\0').filter(file => SOURCE_EXTENSIONS.some(extension => file.endsWith(extension)) && !file.endsWith('.d.ts'));
}

const started = performance.now();
let failed = runSelfTests();
console.log('');

const sources = listSources();
// An empty file set reports universal cleanliness; `git ls-files` answers with
// an empty list rather than an error outside a work tree.
if (sources.length === 0) {
   console.error('✗ SELF-TEST FAILED: no sources were enumerated — this gate scanned nothing');
   process.exit(1);
}

const names = new Set<string>();
const titled: { file: string; titles: Title[] }[] = [];
let unread = 0;
for (const file of sources) {
   let text: string;
   try {
      text = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
   } catch {
      // A staged deletion is still listed by `--cached`.
      continue;
   }
   const scan = scanFile(file, text);
   for (const name of scan.names) names.add(name);
   unread += scan.unread;
   if (scan.titles.length > 0) titled.push({ file, titles: scan.titles });
}

const titleCount = titled.reduce((sum, entry) => sum + entry.titles.length, 0);
if (titleCount === 0) {
   console.error('✗ SELF-TEST FAILED: no test title was found — the extractor has stopped matching');
   process.exit(1);
}

let offences = 0;
for (const { file, titles } of titled) {
   for (const title of titles) {
      for (const violation of violations(title, names)) {
         failed = true;
         offences++;
         console.error(
            `✗ ${file}:${title.line}: ${violation.rule} in ${title.kind === 'it' ? 'an' : 'a'} ${title.kind} title — ${violation.remedy}`
         );
         console.error(`    ${title.text.replaceAll(HOLE, '${…}')}`);
      }
   }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (!failed) {
   console.log(`✓ ${titleCount} test title(s) in ${titled.length} file(s) follow the mechanical title rules (${seconds}s)`);
   // A title held in a variable cannot be read here; the count keeps that visible.
   console.log(`  ${unread} title(s) that are no literal were not checked`);
   process.exit(0);
}
if (offences > 0) {
   console.error(`\nTest-title gate failed: ${offences} title(s) break a rule in docs/contributing/testing.md.`);
}
console.error('(A SELF-TEST failure means the opposite — the gate stopped detecting, so fix the gate.)');
process.exit(1);
