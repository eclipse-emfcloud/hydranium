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
 * Per-package README gate.
 *
 * A published package with no README gets a BLANK page on npm, which is the
 * first thing anyone evaluating it sees. The registry renders the file from the
 * tarball, and npm includes it regardless of the `files` allowlist, so no
 * package needs a `files` entry for it — only the file itself.
 *
 * Presence alone is too weak a check, because the failure this prevents is "the
 * page says nothing", and an empty file satisfies presence while producing
 * exactly that page. So a README must also carry a top-level heading NAMING its
 * own package, have prose under the heading, show how to install itself, warn
 * that it is pre-v0, state its licence, demonstrate something in a code fence,
 * and agree with its own manifest about its peer dependencies. Every predicate
 * is mechanical: the gate refuses to hold a style opinion, because one would be
 * edited away rather than met.
 *
 * Private packages (the examples) are skipped — nothing is distributed.
 *
 * This gate SELF-TESTS against canaries that must fail — one per predicate, so a
 * predicate added without a canary is an untested rule. A checker whose
 * predicate has silently stopped discriminating reports a clean tree, which is
 * indistinguishable from there being nothing to find.
 *
 * Usage:
 *   node scripts/check-package-readmes.mjs
 *   node scripts/check-package-readmes.mjs --self-test    # canaries only
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace directories that may contain publishable packages. */
const WORKSPACE_DIRS = ['packages', 'examples'];

/**
 * Whole-file size floor, in bytes.
 *
 * Distinct from {@link MINIMUM_PROSE}, which measures only what follows the
 * heading: a page can clear one and fail the other, and the pair is what rejects
 * a stub that has been given a licence section and an install line but still
 * says nothing about the package.
 */
const MINIMUM_BODY_BYTES = 400;

/**
 * Prose required under the heading, in characters.
 *
 * Low on purpose. The gate's job is to catch "nobody wrote one", not to judge
 * how much was written; a threshold high enough to argue about would be edited
 * away rather than met.
 */
const MINIMUM_PROSE = 120;

/** Immediate subdirectories, skipping the installed tree. */
function subdirectories(base) {
   if (!existsSync(base)) {
      return [];
   }
   return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
      .map(entry => join(base, entry.name));
}

/**
 * Package directories under a workspace directory, one grouping level deep.
 *
 * A child WITHOUT a `package.json` is descended into rather than skipped: an
 * example family is a plain grouping directory holding one package per host, so
 * a flat scan would stop covering every package it contains while still
 * reporting a clean verdict.
 */
function listPackageDirs(base) {
   return subdirectories(base).flatMap(directory =>
      existsSync(join(directory, 'package.json'))
         ? [directory]
         : subdirectories(directory).filter(nested => existsSync(join(nested, 'package.json')))
   );
}

function listPublishedPackages() {
   return WORKSPACE_DIRS.flatMap(workspaceDir =>
      listPackageDirs(join(REPO_ROOT, workspaceDir))
         .map(directory => ({
            directory,
            manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8'))
         }))
         .filter(({ manifest }) => manifest.private !== true)
         .map(({ directory, manifest }) => ({
            directory,
            name: manifest.name,
            peerDependencies: manifest.peerDependencies ?? {}
         }))
   );
}

function escapeForRegExp(text) {
   return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the page shows how to install THIS package.
 *
 * Flags between the verb and the name are not a deviation to be normalised
 * away: a test-only package is installed `--save-dev` and a bin-first one
 * `--global`, so a literal `npm install <name>` would reject the two packages
 * whose install line is the correct one for them and push both toward a wrong
 * one. The name is anchored on its right so a longer sibling's line — the
 * copy-paste failure this pairs with — cannot satisfy a shorter package.
 */
function hasInstallCommand(contents, packageName) {
   const command = new RegExp(`npm install(?:\\s+-{1,2}[\\w-]+)*\\s+${escapeForRegExp(packageName)}(?![\\w./-])`);
   return command.test(contents);
}

/** One comparator term of a semver range, as npm would accept it in a manifest. */
const VERSION_TERM = /^(?:[<>]=?|[\^~=])?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * A range as the two sides spell it differently.
 *
 * A markdown table cell must escape `|`, so the same range reads `^8.0.0 ||
 * ^9.0.0` in the manifest and `^8.0.0 \|\| ^9.0.0` on the page. Comparing the
 * raw strings would therefore reject every union range in a table — the shape
 * the pinned transport peers all use — and the gate would be turned off rather
 * than believed.
 */
function normalizeRange(text) {
   return text.replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a backticked span is a version range and nothing else.
 *
 * Deliberately strict: only a fully-qualified `major.minor.patch` counts, so a
 * size (`~86 MB`), a Node floor (`22`) or a prose aside cannot be mistaken for a
 * range the page is quoting. A range this rejects is treated as prose, which
 * loses coverage rather than inventing a violation.
 */
function isVersionRange(text) {
   const terms = text
      .split('||')
      .map(term => term.trim())
      .filter(term => term.length > 0);
   return terms.length > 0 && terms.every(term => term.split(/\s+/).every(part => VERSION_TERM.test(part)));
}

/**
 * Whether a line names this package and not a longer one that starts with it.
 *
 * `@scope/peer` must not be satisfied by `@scope/peer-extra`, or a peer dropped
 * from the page goes on reading as mentioned for as long as a sibling with a
 * longer name survives. A trailing `/` is allowed through, because
 * `@hydranium/core/node` does mention `@hydranium/core`.
 */
function mentions(line, packageName) {
   return new RegExp(`(?<![\\w@/-])${escapeForRegExp(packageName)}(?![\\w-])`).test(line);
}

/**
 * Why the page disagrees with the manifest about its peers, or undefined if it
 * does not.
 *
 * A peer is the one dependency npm will not install for the consumer, so the
 * README is the install instructions — a peer added, or a range widened, without
 * touching the prose ships a consumer an install that fails at runtime rather
 * than at install time. That is publish surface, not documentation polish, which
 * is why it is gated at all.
 *
 * Two mechanical rules only, both anchored on the manifest:
 *
 * - every declared peer is named somewhere on the page;
 * - a line that names a peer AND quotes a range must quote the declared one.
 *
 * What it deliberately does NOT catch, because prose is prose and a false
 * positive here gets the gate disabled rather than obeyed:
 *
 * - a peer named with no range anywhere — quoting ranges is a choice a README
 *   makes, and a page that only lists names is not wrong;
 * - a range that sits on a different line from the peer it belongs to, since
 *   nothing short of parsing the prose associates the two, and guessing across
 *   lines is how a wrapped sentence becomes a false accusation;
 * - a stale entry naming something that is no longer a peer at all, which needs
 *   the gate to decide that a given line is a peer line rather than reading that
 *   off the manifest;
 * - whether an optional peer is described as optional, or a peer's purpose is
 *   described correctly. Both are judgements, and a gate that held one would be
 *   argued with instead of met.
 *
 * Extra ranges on a matching line are accepted: the rule is that the declared
 * range is among the ones quoted, so a sentence naming two peers with both their
 * ranges satisfies each of them.
 */
function peerProblem(contents, peerDependencies) {
   const lines = contents.split('\n');
   for (const [peer, declaredRange] of Object.entries(peerDependencies)) {
      const naming = lines.filter(line => mentions(line, peer));
      if (naming.length === 0) {
         return `peer ${peer} is declared but never named on the page`;
      }
      const declared = normalizeRange(declaredRange);
      for (const line of naming) {
         const quoted = [...line.matchAll(/`([^`\n]+)`/g)].map(match => normalizeRange(match[1])).filter(isVersionRange);
         if (quoted.length > 0 && !quoted.includes(declared)) {
            return `quotes ${quoted.join(', ')} for peer ${peer}, manifest declares ${declared}`;
         }
      }
   }
   return undefined;
}

/**
 * Why this README would render as a useless npm page, or would misinstruct a
 * consumer, or undefined if it would do neither. Takes the contents rather than
 * a path so the canaries exercise the same predicate the real scan does.
 *
 * Ordered cheapest-structural first, so a stub reports the reason a reader can
 * act on rather than the last one it happens to trip. Peer agreement comes last
 * because it is the only predicate that reads the manifest, and a page with no
 * heading has nothing to disagree with yet.
 */
function readmeProblem(contents, packageName, peerDependencies = {}) {
   const lines = contents.split('\n');
   const headingIndex = lines.findIndex(line => /^#\s+\S/.test(line));
   if (headingIndex < 0) {
      return 'no top-level heading';
   }
   // Anchored on the HEADING, not the whole file: a page copied from a sibling
   // still mentions its own package somewhere in prose or in a link, so a
   // whole-file search accepts exactly the copy-paste this predicate exists to
   // reject — and the heading is what the npm page leads with.
   if (!lines[headingIndex].includes(packageName)) {
      return `heading does not name ${packageName}: ${lines[headingIndex].trim()}`;
   }
   const prose = lines
      .slice(headingIndex + 1)
      .join('\n')
      .trim();
   if (prose.length < MINIMUM_PROSE) {
      return `only ${prose.length} characters under the heading, need ${MINIMUM_PROSE}`;
   }
   if (!hasInstallCommand(contents, packageName)) {
      return `no install command: expected an "npm install ${packageName}" line`;
   }
   if (!/alpha/i.test(contents)) {
      return 'no pre-v0 status warning: the page never says "alpha"';
   }
   if (!/^##\s+License\b/m.test(contents) || !/\bMIT\b/.test(contents)) {
      return 'no "## License" section naming MIT';
   }
   const bytes = Buffer.byteLength(contents, 'utf-8');
   if (bytes < MINIMUM_BODY_BYTES) {
      return `only ${bytes} bytes, need ${MINIMUM_BODY_BYTES}`;
   }
   if (!/^ {0,3}```/m.test(contents)) {
      return 'no fenced code block: nothing on the page shows the package in use';
   }
   return peerProblem(contents, peerDependencies);
}

const CANARY_PACKAGE = '@scope/canary';

/**
 * The peers the canary page is checked against.
 *
 * `@scope/peer` is a strict PREFIX of the other two, so a mention test that had
 * lost its right anchor would accept a page that names only the longer ones —
 * the way this predicate would degrade into reporting a clean tree. The union
 * range is here because a markdown table escapes its `|`, and that escaping is
 * the one transformation the comparison has to undo.
 */
const CANARY_PEERS = {
   '@scope/peer': '^1.2.3',
   '@scope/peer-extra': '^4.0.0',
   '@scope/peer-union': '^8.0.0 || ^9.0.0'
};

/** The table row the well-formed page carries for a peer. */
function canaryPeerRow(peer) {
   return `| \`${peer}\` | \`${CANARY_PEERS[peer].replaceAll('|', '\\|')}\` |`;
}

/**
 * A page that satisfies every predicate. Every must-fail canary is derived from
 * it by removing exactly ONE property, so a canary that reddens has isolated the
 * predicate it names instead of tripping over an unrelated gap — which is the
 * way a self-test stops discriminating without anyone noticing.
 *
 * Held as lines rather than one literal so a fence needs no backtick escaping.
 */
const WELL_FORMED = [
   `# ${CANARY_PACKAGE}`,
   '',
   'The discrimination canary for this gate: it must PASS. Without one, a predicate that had degenerated',
   'into rejecting everything would satisfy every must-fail canary below, and would then redden every',
   'package in the repository rather than reporting a gate whose verdict has stopped meaning anything.',
   '',
   '## Install',
   '',
   '```bash',
   `npm install ${CANARY_PACKAGE}`,
   '```',
   '',
   'The declared peer dependencies are:',
   '',
   '| Peer | Range |',
   '| ---- | ----- |',
   canaryPeerRow('@scope/peer'),
   canaryPeerRow('@scope/peer-extra'),
   canaryPeerRow('@scope/peer-union'),
   '',
   '## Status',
   '',
   'Alpha - pre-v0, and the API is not stable.',
   '',
   '## License',
   '',
   'MIT - see this package LICENSE.',
   ''
].join('\n');

/**
 * A page that names every peer and quotes a range for none of them. It must
 * PASS: the gate compares ranges it is given and requires none, and a page that
 * only lists names is a documentation choice rather than a wrong install
 * instruction. Without this canary the range rule could tighten into "every peer
 * must carry a range" and nothing would report the change.
 */
const PEERS_WITHOUT_RANGES = WELL_FORMED.split('\n')
   .filter(line => !line.startsWith('| '))
   .concat([`Its peers are ${Object.keys(CANARY_PEERS).join(', ')} - install them yourself.`, ''])
   .join('\n');

/**
 * A stub that has learned the shape of a page without acquiring its content: it
 * carries a heading, an install line, a status word and a licence, and is still
 * useless. It is the reason the size floor is not merely the prose floor.
 */
const SHAPED_STUB = [
   `# ${CANARY_PACKAGE}`,
   '',
   'A stub with the right sections and nothing in them, which is what a template leaves behind when the',
   'person who ran it never came back to fill it in.',
   '',
   `npm install ${CANARY_PACKAGE} - alpha.`,
   '',
   '## License',
   '',
   'MIT',
   ''
].join('\n');

/**
 * The canaries. `problem: undefined` is the discrimination case — without one,
 * a predicate that had degenerated into "always fails" would pass every
 * must-fail canary and redden the whole repository instead.
 */
const CANARIES = [
   { name: 'no-heading', contents: WELL_FORMED.replace(`# ${CANARY_PACKAGE}`, CANARY_PACKAGE), problem: 'no top-level heading' },
   // Names a DIFFERENT package throughout, and therefore does not itself
   // contain the string it exists to prove absent.
   {
      name: 'wrong-package-name',
      contents: WELL_FORMED.replaceAll(CANARY_PACKAGE, '@scope/other'),
      problem: `does not name ${CANARY_PACKAGE}`
   },
   // The install line still names the right package, so a whole-FILE search
   // accepts this page. Only the heading is a sibling's, which is what the
   // copy-paste failure actually looks like and the one a human eye passes.
   {
      name: 'sibling-heading',
      contents: WELL_FORMED.replace(`# ${CANARY_PACKAGE}`, '# @scope/other'),
      problem: `heading does not name ${CANARY_PACKAGE}`
   },
   { name: 'heading-only', contents: `# ${CANARY_PACKAGE}\n`, problem: 'characters under the heading' },
   {
      name: 'no-install',
      contents: WELL_FORMED.replace(`npm install ${CANARY_PACKAGE}`, 'node ./lib/cli.js'),
      problem: 'no install command'
   },
   { name: 'no-status-warning', contents: WELL_FORMED.replace('Alpha - pre-v0', 'Pre-v0'), problem: 'no pre-v0 status warning' },
   { name: 'no-license-heading', contents: WELL_FORMED.replace('## License', '## Legal'), problem: 'no "## License" section naming MIT' },
   {
      name: 'license-without-mit',
      contents: WELL_FORMED.replace('MIT - see this package LICENSE.', 'See this package LICENSE.'),
      problem: 'no "## License" section naming MIT'
   },
   // Declares no peers: it is the one canary not derived from the well-formed
   // page, so giving it the peer table's obligations would let it trip two
   // predicates and stop isolating either.
   { name: 'shaped-stub', contents: SHAPED_STUB, peers: {}, problem: `need ${MINIMUM_BODY_BYTES}` },
   { name: 'no-code-fence', contents: WELL_FORMED.replace('```bash\n', '').replace('```\n', ''), problem: 'no fenced code block' },
   // The row for the SHORTEST peer name goes; the two that extend it stay. A
   // mention test without its right anchor still finds the string inside them
   // and reports this page clean.
   {
      name: 'unmentioned-peer',
      contents: WELL_FORMED.replace(`${canaryPeerRow('@scope/peer')}\n`, ''),
      problem: 'peer @scope/peer is declared but never named'
   },
   {
      name: 'stale-peer-range',
      contents: WELL_FORMED.replace('`^1.2.3`', '`^1.0.0`'),
      problem: 'quotes ^1.0.0 for peer @scope/peer, manifest declares ^1.2.3'
   },
   // The union range, with the table escaping left in place on one side only —
   // the comparison this canary holds is that the escaping is undone, not that
   // the two spellings happen to be equal.
   {
      name: 'stale-union-range',
      contents: WELL_FORMED.replace('`^8.0.0 \\|\\| ^9.0.0`', '`^7.0.0 \\|\\| ^8.0.0`'),
      problem: 'for peer @scope/peer-union, manifest declares ^8.0.0 || ^9.0.0'
   },
   { name: 'peers-without-ranges', contents: PEERS_WITHOUT_RANGES, problem: undefined },
   { name: 'well-formed', contents: WELL_FORMED, problem: undefined }
];

function runSelfTest() {
   const problems = [];
   for (const canary of CANARIES) {
      const actual = readmeProblem(canary.contents, CANARY_PACKAGE, canary.peers ?? CANARY_PEERS);
      if (canary.problem === undefined) {
         if (actual !== undefined) {
            problems.push(`canary ${canary.name} must pass but was rejected: ${actual}`);
         }
      } else if (actual === undefined) {
         problems.push(`canary ${canary.name} must fail with "${canary.problem}" but passed`);
      } else if (!actual.includes(canary.problem)) {
         problems.push(`canary ${canary.name} failed with "${actual}", expected "${canary.problem}"`);
      }
   }
   return problems;
}

function main() {
   const selfTestProblems = runSelfTest();
   if (selfTestProblems.length > 0) {
      console.error('Self-test FAILED — the gate no longer discriminates, so its verdict is worthless:');
      selfTestProblems.forEach(problem => console.error(`  ${problem}`));
      process.exit(2);
   }
   if (process.argv.includes('--self-test')) {
      console.log(`✓ self-test: ${CANARIES.length} canaries behave as specified`);
      return;
   }

   const packages = listPublishedPackages();
   const problems = [];
   for (const { directory, name, peerDependencies } of packages) {
      const readme = join(directory, 'README.md');
      if (!existsSync(readme)) {
         problems.push(`${name}: no README.md — its npm page would be blank`);
         continue;
      }
      const problem = readmeProblem(readFileSync(readme, 'utf-8'), name, peerDependencies);
      if (problem) {
         problems.push(`${name}: ${problem}`);
      }
   }

   if (problems.length > 0) {
      problems.forEach(problem => console.error(problem));
      process.exit(1);
   }

   console.log(`✓ all ${packages.length} published packages carry a README that would render`);
}

main();
