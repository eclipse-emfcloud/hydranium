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
 * The comment gates. Two families, one comment extractor.
 *
 * ## No `{@link Target}` inside a `//` line comment
 *
 * A `{@link}` tag is JSDoc, and JSDoc is a `/** … *\/` block. In a `//` comment
 * the tag reaches no parser, so it neither resolves nor renders — an editor
 * shows the reader the literal seven characters `{@link` and the symbol name is
 * not a link to anything. The remedy is one character either way: promote the
 * comment to a block, or demote the tag to backticks.
 *
 * Why a GATE and not a sweep. This family was swept once, by hand, across
 * thirteen lines — and it came back inside 36 hours, introduced by a commit
 * whose whole purpose was comment hygiene. So a repeat sweep is MEASURED to be
 * insufficient: the shape is easy to write by accident when collapsing prose
 * from a block comment into a line run, and nothing but a check notices.
 *
 * Three deliberate limits, each one a thing this gate is asked NOT to flag:
 *
 * - **A `/*`-not-`/**` banner is out of scope.** Its tags reach no parser
 *   either, but such a banner is sometimes chosen on purpose: a license-header
 *   tool typically REPLACES a leading block comment, so file-purpose prose
 *   written as `/**` is silently deleted the first time an adopter runs theirs.
 *   Widening this gate to block comments would therefore demand a change that
 *   costs the prose. Flagging one is the gate being wrong, and
 *   {@link SELF_TESTS} asserts it does not.
 * - **A `{@link}` with no target is prose, not a tag.** Writing about the tag
 *   family — as this repo's own audit tooling does — needs to name it, and an
 *   empty tag renders nothing in any case. The target is what makes it a claim
 *   about a symbol.
 * - **Text inside a template literal is not a comment.** The `init` scaffold
 *   emits `//` prose runs into the files it writes, so a tag in one of those
 *   would render as literal text in the ADOPTER's file — but no parser sees a
 *   comment there, and the emission is byte-compared against its provenance
 *   target instead, which is the check that owns that text.
 *
 * ## No pointer that rots
 *
 * A comment must stand alone: `conventions.md` bans line references, work-item
 * ids and work-log paths outright, on the measurement that every line
 * reference a 2026 sweep checked already named the wrong thing. None of those
 * shapes has ever been enforceable, because all three occur legitimately in
 * CODE — a stack-trace fixture, an error-message assertion, a memory-tier
 * label, a URL with a port — so a raw-line regex is noise. Restricting them to
 * comments is what makes them checkable, and the extractor below already
 * exists for the other family.
 *
 * {@link POINTER_RULES} is deliberately narrower than the prose ban. Enforced
 * only where a legitimate reading does not exist, so the gate never has to
 * acquire exemptions: a durable concept doc is left alone (a comment may point
 * at one as further reading once it already stands alone), and so are
 * "the guard above", a bare `line 12` and a skill name — the last because its
 * token space is the npm scope and the shipped binary name, so any pattern for
 * it fires on legitimate API prose. {@link isPointerScoped} keeps it off
 * `examples/` for the reason `conventions.md` gives, and off the private script
 * tree, whose whole subject matter is the ids and paths these rules forbid.
 *
 * ## Both families
 *
 * Comment ranges come from the TypeScript parser, never from a line regex. The
 * regex form of the link check — a line-anchored `//` followed by anything and
 * then the tag — is what defined the family's fan-out originally, and it is
 * wrong in both directions: it misses a tag in a trailing comment after code,
 * and it reports a `//` sitting inside a string or a template literal. Both
 * directions were live in this repo.
 *
 * Usage: node scripts/check-link-tags.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions the TypeScript parser can read and JSDoc can appear in. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * A tag with a TARGET. The target is the whole point: `{@link}` alone is how
 * prose names the family, and it renders as nothing either way.
 */
const LINK_TAG = /\{@link\s+\S/;

/**
 * Every comment range in a file, keyed so a range reached by two tokens is
 * counted once.
 *
 * Recursion is over `getChildren`, not `forEachChild`: a comment sitting
 * between two of a node's own tokens is leading trivia of the second TOKEN, and
 * `forEachChild` visits no tokens at all. The scanner is the other tempting
 * route and is a trap — driven directly it desynchronises on the first template
 * literal in a file, because continuing past a `TemplateHead` needs an explicit
 * re-scan, and every comment after that point is lost with no error. Measured
 * on this repo: the scanner form found one of the three live occurrences.
 */
function commentRanges(sourceFile, text) {
   const byPosition = new Map();
   const record = ranges => {
      for (const range of ranges ?? []) byPosition.set(`${range.pos}:${range.end}`, range);
   };
   const walk = node => {
      record(ts.getLeadingCommentRanges(text, node.getFullStart()));
      record(ts.getTrailingCommentRanges(text, node.getEnd()));
      for (const child of node.getChildren(sourceFile)) walk(child);
   };
   walk(sourceFile);
   return [...byPosition.values()];
}

/**
 * The detection, as a pure function of one file's text, so the self-test can
 * drive it with fabricated sources rather than with fixture files. A fixture
 * would have to be excluded from the real scan by a rule that could itself stop
 * matching, which is the failure this gate is guarding against one level up.
 */
export function linkTagsInLineComments(fileName, text) {
   if (!text.includes('{@link')) return [];
   const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
   const hits = [];
   for (const range of commentRanges(sourceFile, text)) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const comment = text.slice(range.pos, range.end);
      if (!LINK_TAG.test(comment)) continue;
      hits.push({ line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1, comment: comment.trim() });
   }
   return hits.sort((left, right) => left.line - right.line);
}

/**
 * The pointer rules, matched inside a comment and nowhere else.
 *
 * Each is narrowed to a shape that has no legitimate reading, because a gate
 * that needs exemptions is a gate whose exemptions rot:
 *
 * - The colon in a file reference takes no surrounding space, so a comment
 *   writing `package.json: 2 entries` is prose about a file rather than a
 *   pointer into one, and a URL's port survives because no host ends in a
 *   source extension.
 * - A work-item id is matched at two digits or more, which is every id this
 *   repository's tracker issues. One digit is where the memory-tier labels
 *   `L1`, `L2` and `L3` live, and the heap classifier's comments are full of
 *   them.
 * - A work-log reference is matched by BASENAME, so it holds whichever
 *   directory the log is filed under. The directory is the part that moves.
 */
const POINTER_RULES = [
   {
      id: 'file-line-reference',
      pattern: /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|md|langium):\d+/g,
      remedy: 'restate what lives there instead — a line reference rots on the next edit'
   },
   {
      id: 'work-item-id',
      pattern: /\bL\d{2,}\b/g,
      remedy: 'keep the constraint the id was gesturing at and drop the citation'
   },
   {
      id: 'work-log-reference',
      pattern: /\b(?:MIGRATION|open-work|completed-work)\.md\b/g,
      remedy: 'the work log records what was done; a comment describes what the code does'
   }
];

/**
 * Trees the pointer rules do not reach, as top-level directory NAMES.
 *
 * The examples tree is out because its comments follow the opposite pull —
 * that code exists to be read and copied, so a worked reference there is the
 * point. The private tree is out because it holds the tooling FOR the work
 * log: its subject matter is exactly the ids and paths these rules forbid, and
 * a gate that reddened on it would be asking a script to stop naming what it
 * operates on.
 *
 * Names rather than path prefixes, and matched a segment at a time, because
 * this file ships. A `dir/sub/file` spelling of the private tree here would
 * disclose a layout that reaches no public clone, and the boundary gate reads
 * it exactly that way — correctly.
 */
const EXAMPLES_TREE = 'examples';
const PRIVATE_TREE = 'internal';

/** Where the pointer rules apply. */
function isPointerScoped(file) {
   const [topLevel] = file.split('/');
   return topLevel !== EXAMPLES_TREE && topLevel !== PRIVATE_TREE;
}

/**
 * Every pointer-rule violation in one file's comments, of any comment kind.
 *
 * Block comments count as much as line ones: a rotted line reference reads the
 * same in a JSDoc block, and the block form is where the framework's
 * load-bearing prose lives.
 */
export function pointersInComments(fileName, text) {
   if (!isPointerScoped(fileName)) return [];
   const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
   const hits = [];
   for (const range of commentRanges(sourceFile, text)) {
      const comment = text.slice(range.pos, range.end);
      for (const rule of POINTER_RULES) {
         rule.pattern.lastIndex = 0;
         const matches = [...new Set([...comment.matchAll(rule.pattern)].map(match => match[0]))];
         if (matches.length === 0) continue;
         hits.push({
            ruleId: rule.id,
            remedy: rule.remedy,
            line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
            matches
         });
      }
   }
   return hits.sort((left, right) => left.line - right.line);
}

/**
 * Fabricated sources that MUST be classified a particular way, in both
 * directions. The repo is clean once the three live sites are fixed, so a clean
 * run carries no information about whether the detection still fires — these
 * make "nothing to find" and "no longer looking" distinguishable on every run.
 *
 * The negative cases are not padding. Each is a real shape this repo contains
 * and would be actively harmed by flagging: the `/*` banner whose form is
 * deliberate, the empty tag its own tooling writes in prose, and the `//` run
 * the `init` scaffold emits from inside a template literal.
 */
const SELF_TESTS = [
   {
      name: 'a tag in a line comment is flagged',
      flagged: true,
      source: ['// See {@link Target}.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a tag in a TRAILING line comment, after code, is flagged',
      flagged: true,
      source: 'export const value = 1; // See {@link Target}.\n'
   },
   {
      name: 'a tag in a line comment AFTER a template literal is flagged',
      flagged: true,
      source: ['export const text = `a ${1} b`;', '// See {@link Target}.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a tag in a `/**` block is not flagged',
      flagged: false,
      source: ['/** See {@link Target}. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a tag in a `/*`-not-`/**` banner is not flagged',
      flagged: false,
      source: ['/*', ' * See {@link Target}.', ' */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a tag with no target is prose, not flagged',
      flagged: false,
      source: ['// The `{@link}` family, named in prose.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a `//` inside a string is not a comment, not flagged',
      flagged: false,
      source: 'export const text = "// See {@link Target}.";\n'
   },
   {
      name: 'a `//` inside a template literal is not a comment, not flagged',
      flagged: false,
      source: 'export const text = `// See {@link Target}.`;\n'
   }
];

/**
 * The pointer family's fabricated sources, in both directions and with the
 * expected RULE pinned rather than merely "something fired".
 *
 * These carry more weight than the link family's, because every pointer rule
 * is a LATENT ban: the tree is clean of all three shapes today, so a pattern
 * that matches nothing produces exactly the verdict a working one does. Only a
 * probe that must fire distinguishes them.
 *
 * The negatives are the measured near misses, each a real shape this repo
 * contains: the memory-tier labels in the heap classifier, the shipped binary
 * name, a port, prose about a file, and a durable concept doc offered as
 * further reading. Flagging any of them would be the gate being wrong.
 */
const POINTER_SELF_TESTS = [
   {
      name: 'a file:line reference in a block comment is flagged',
      rule: 'file-line-reference',
      file: 'packages/core/src/probe.ts',
      source: ['/** As set up in scratch-workspace.ts:88. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a file:line reference in a line comment is flagged',
      rule: 'file-line-reference',
      file: 'packages/core/src/probe.ts',
      source: ['// As set up in scratch-workspace.ts:88.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a file:line reference in a script is flagged',
      rule: 'file-line-reference',
      file: 'scripts/probe.mjs',
      source: ['// Replicates the rules at check-public-boundary.mjs:301.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a work-item id in a comment is flagged',
      rule: 'work-item-id',
      file: 'packages/core/src/probe.ts',
      source: ['/** Deferred under L508 until the transfer shape settles. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a work-log reference in a comment is flagged',
      rule: 'work-log-reference',
      file: 'packages/core/src/probe.ts',
      source: ['/** The rationale is in MIGRATION.md. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a work-log reference keyed by basename is flagged whatever the directory',
      rule: 'work-log-reference',
      file: 'packages/core/src/probe.ts',
      source: ['/** Tracked in docs/open-work.md. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'the same reference in the examples tree is not flagged',
      rule: null,
      file: `${EXAMPLES_TREE}/order-flow/server/src/probe.ts`,
      source: ['/** As set up in scratch-workspace.ts:88, deferred under L508. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'the same reference in the private tree is not flagged',
      rule: null,
      file: `${PRIVATE_TREE}/scripts/probe.mjs`,
      source: ['/** As set up in scratch-workspace.ts:88, deferred under L508. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a file:line reference inside a string is not a comment, not flagged',
      rule: null,
      file: 'packages/core/src/probe.ts',
      source: 'export const trace = "at scratch-workspace.ts:88 — deferred under L508";\n'
   },
   {
      name: 'a memory-tier label is not a work-item id, not flagged',
      rule: null,
      file: 'packages/cli/probe.mjs',
      source: ['// Retained bytes are split across L1, L2 and L3.', 'export const value = 1;'].join('\n')
   },
   {
      name: 'the shipped binary name is not a work-item id, not flagged',
      rule: null,
      file: 'packages/cli/src/probe.ts',
      source: ['/** Reached through `hydranium-cli reflect`. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a port is not a line number, not flagged',
      rule: null,
      file: 'packages/core/src/probe.ts',
      source: ['/** The Theia app answers on localhost:3001. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'prose naming a file without pointing into it is not flagged',
      rule: null,
      file: 'packages/core/src/probe.ts',
      source: ['/** The manifest declares package.json: 2 gated subpaths. */', 'export const value = 1;'].join('\n')
   },
   {
      name: 'a durable concept doc offered as further reading is not flagged',
      rule: null,
      file: 'packages/core/src/probe.ts',
      source: ['/** The four layers are set out in docs/concepts/document-layers.md. */', 'export const value = 1;'].join('\n')
   }
];

function runSelfTests() {
   let broken = false;
   for (const probe of SELF_TESTS) {
      const hits = linkTagsInLineComments('self-test.ts', probe.source);
      if (hits.length > 0 === probe.flagged) {
         console.log(`✓ self-test: ${probe.name}`);
         continue;
      }
      broken = true;
      console.error(`✗ SELF-TEST FAILED: ${probe.name} — this gate has gone blind (got ${hits.length} hit(s))`);
   }
   for (const probe of POINTER_SELF_TESTS) {
      const fired = [...new Set(pointersInComments(probe.file, probe.source).map(hit => hit.ruleId))];
      const passed = probe.rule === null ? fired.length === 0 : fired.includes(probe.rule);
      if (passed) {
         console.log(`✓ self-test: ${probe.name}`);
         continue;
      }
      broken = true;
      console.error(`✗ SELF-TEST FAILED: ${probe.name} — expected ${probe.rule ?? 'nothing'}, got ${fired.join(', ') || 'nothing'}`);
   }
   const uncovered = POINTER_RULES.map(rule => rule.id).filter(id => !POINTER_SELF_TESTS.some(probe => probe.rule === id));
   if (uncovered.length > 0) {
      broken = true;
      console.error(`✗ SELF-TEST FAILED: pointer rules with no must-fire probe: ${uncovered.join(', ')}`);
   }
   return broken;
}

/** Tracked and new-but-untracked sources, so a bad comment is caught before it is committed. */
function listSources() {
   const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024
   });
   return stdout
      .split('\0')
      .filter(Boolean)
      .filter(file => SOURCE_EXTENSIONS.some(extension => file.endsWith(extension)));
}

let failed = runSelfTests();
console.log('');

const sources = listSources();
// A file set that has collapsed to nothing reports universal cleanliness, and
// `git ls-files` answers with an empty list rather than an error when run
// outside a work tree.
if (sources.length === 0) {
   console.error('✗ SELF-TEST FAILED: no sources were enumerated — this gate scanned nothing');
   process.exit(1);
}

// The pointer family is scoped, and a scope predicate that has stopped
// matching reports universal cleanliness just as convincingly as a clean tree.
const pointerScoped = sources.filter(isPointerScoped);
if (pointerScoped.length === 0) {
   console.error('✗ SELF-TEST FAILED: the pointer rules reached no source file — the scope predicate excludes everything');
   process.exit(1);
}

let offences = 0;
for (const file of sources) {
   let text;
   try {
      text = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
   } catch {
      // A staged deletion is still listed by `--cached`.
      continue;
   }
   for (const hit of linkTagsInLineComments(file, text)) {
      failed = true;
      offences++;
      console.error(`✗ ${file}:${hit.line}: {@link} in a // comment — promote the comment to /** */ or use backticks`);
      console.error(`    ${hit.comment}`);
   }
   for (const hit of pointersInComments(file, text)) {
      failed = true;
      offences++;
      console.error(`✗ ${file}:${hit.line}: ${hit.ruleId} in a comment (${hit.matches.join(', ')}) — ${hit.remedy}`);
   }
}

if (!failed) {
   console.log(`✓ no {@link} in a // comment across ${sources.length} source file(s)`);
   console.log(`✓ no rotting pointer in a comment across ${pointerScoped.length} in-scope source file(s)`);
   process.exit(0);
}
if (offences > 0) {
   console.error(`\nComment gate failed: ${offences} comment(s) either render as literal text or point at something that moves.`);
}
console.error('(A SELF-TEST failure means the opposite — the gate stopped detecting, so fix the gate.)');
process.exit(1);
