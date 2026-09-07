/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DIFF_FLAG, runAnalyzeHeap, type AnalyzeHeapDeps } from './analyze-heap.js';
import { exitWithUsage, helpRequested, printHelp, type UsageError } from './harness-args.js';
import { OUT_FILE_FLAG } from './headless-harness.js';

/**
 * Flags whose value is mandatory. `--diff` is here for
 * {@link helpRequested}'s benefit — it takes TWO values, which the parser below
 * handles as its own case.
 */
const VALUE_FLAGS = [DIFF_FLAG, OUT_FILE_FLAG, '--validate', '--json', '--threshold', '--classifier'] as const;

/**
 * Flags whose value may be omitted: each names a top-N the analyzer defaults
 * when the token is bare, so a following token is a value only when it is not
 * itself a flag.
 */
const OPTIONAL_VALUE_FLAGS = ['--breakdown-depth', '--top-concepts', '--strings', '--cutpoints', '--docs', '--holders'] as const;

/** Presence-only flags. */
const BOOL_FLAGS = ['--cutpoints-all', '--renderer'] as const;

/**
 * Every flag `analyze-heap` accepts, derived from the three sets the parser
 * scans so the list cannot claim a flag the parser would reject. `--help` is
 * absent because it selects the help block rather than describing a run.
 */
export const ANALYZE_HEAP_FLAGS: readonly string[] = [...VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...BOOL_FLAGS];

/** The subset whose value is mandatory, so `--help` in a value position reads as data. */
export const ANALYZE_HEAP_VALUE_FLAGS: readonly string[] = VALUE_FLAGS;

/**
 * The `--help` text, as data, held to {@link ANALYZE_HEAP_FLAGS} by a test.
 *
 * The analyzer is a standalone ESM asset spawned as a child, so this is the only
 * copy: a second one beside its argv reads is what let its flags and its help
 * drift apart with nothing able to see it.
 */
export const ANALYZE_HEAP_HELP: readonly string[] = [
   'Usage: hydranium-cli analyze-heap <snapshot> [options]',
   '       hydranium-cli analyze-heap --diff <baseline.json> <current.json> [--threshold <pct>]',
   '',
   'Langium-aware V8 heap-snapshot analyzer (memlab-based). A default run (just',
   '<snapshot>) prints a Markdown report to stdout: concept table, a hierarchical',
   'breakdown (each concept group drilled into its colon-delimited sub-levels, e.g.',
   'AST node -> $type, GModel -> kind -> subtype), the duplicate-string / cut-point /',
   'per-document drill-downs, and sample retainer paths. Loading is the only real',
   'cost, so the drill-downs run by default; tune or disable them with the flags',
   'below. The Markdown reads fine as text, saves as a .md file (--out-file), and',
   'is ideal input for the memory-analysis skill.',
   '',
   'Reading a snapshot needs the optional @memlab/core + @memlab/heap-analysis peer',
   'dependencies (`npm install @memlab/core @memlab/heap-analysis`); --diff and',
   '--help need neither.',
   '',
   'Options:',
   '  <snapshot>               the .heapsnapshot to read; omit only with --diff (required).',
   '  --out-file <file.md>     also write the Markdown report to a file',
   '  --breakdown-depth [N]    max DISPLAY depth of the hierarchical breakdown',
   '                           (default: full depth). Aggregation is always',
   '                           depth-agnostic; a cap only hides deeper rows — their',
   '                           bytes still roll up into the deepest shown row.',
   '  --top-concepts [N]       how many of the biggest anchor concepts get a',
   '                           retainer-path sample and are the default --holders',
   '                           targets (default 6)',
   '  --strings [N]            duplicate plain strings, top N (default 20; 0 = off)',
   '  --cutpoints [N]          lightweight sole owners, top N (default 10; 0 = off)',
   '  --cutpoints-all          include Node/V8/server runtime owners (default: model only)',
   '  --docs [N]               heaviest documents, top N (default 15; 0 = off).',
   '                           Langium/server-only — skipped in --renderer mode (a',
   '                           renderer heap has no documents).',
   '  --holders [a,b,c]        who holds each concept: dominator + referrer tallies,',
   '                           comma-separated, one heap pass (e.g. CST,Range,Map);',
   '                           no value = the top model concepts',
   "  --validate <gt.json>     validate the snapshot's $type classification against",
   '                           the live model (ground truth from the',
   '                           hydranium-cli ast-ground-truth subcommand); flags',
   '                           drift and computed/derived types',
   '  --json <file>            write the analysis as JSON (baseline artifact for --diff)',
   '  --diff <base> <cur>      diff two analysis JSONs; prints deltas + verdict,',
   '                           exits non-zero on regression (no snapshot needed)',
   '  --threshold <pct>        regression threshold for --diff, % growth of total',
   '                           shallow (default 5)',
   '  --renderer               analyze a BROWSER/renderer heap (the browser-heap',
   '                           artefact, from CDP) instead of a Langium server heap:',
   '                           buckets by DOM vocabulary (Detached DOM / DOM node /',
   '                           Event listener) and the retainer paths to each detached',
   '                           concept ARE the listener-retainer analysis. Skips the',
   '                           Langium/GLSP classifiers + --validate (no ground truth).',
   '  --classifier <file>      ESM module default-exporting a ConceptClassifier',
   '                           (classify(node) -> a colon-delimited label path, +',
   '                           optional anchorConcepts/grammarTypes/isAnchor) to label',
   "                           a head's own concepts; repeatable. Tried BEFORE the",
   '                           built-in Langium + GLSP defaults (return undefined to',
   '                           defer), so a more specific classifier overrides a',
   '                           default. Order = precedence.',
   '  -h, --help               show this help',
   '',
   'Notes: snapshot is the language-server process only (no other processes, native',
   'memory, or browser heap).'
];

/** What {@link parseAnalyzeHeapArgs} recovered from an argv. */
export interface AnalyzeHeapArgs {
   /** `true` when the argv selects the JSON-vs-JSON diff, which reads no snapshot. */
   readonly diff: boolean;
   /** The `.heapsnapshot` to read; absent only on the {@link diff} path. */
   readonly snapshot?: string;
}

/**
 * Validate the argv the analyzer will be handed.
 *
 * The values themselves stay the analyzer's to read — it is a standalone ESM
 * asset spawned as a child, and duplicating its numeric coercions here would be
 * a second place for them to drift. What this pass adds is the rejection every
 * sibling subcommand performs: an unrecognised token left inert makes a typo'd
 * `--treshold 0` apply the default silently, so the caller believes a threshold
 * is in force.
 */
export function parseAnalyzeHeapArgs(args: string[], onError: UsageError = exitWithUsage): AnalyzeHeapArgs {
   const mandatoryValue = new Set<string>(VALUE_FLAGS);
   const optionalValue = new Set<string>(OPTIONAL_VALUE_FLAGS);
   const presenceOnly = new Set<string>(BOOL_FLAGS);
   let diff = false;
   let snapshot: string | undefined;
   for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === DIFF_FLAG) {
         diff = true;
         if (args[index + 1] === undefined || args[index + 2] === undefined) {
            onError(`Missing value for ${DIFF_FLAG}`);
         }
         index += 2;
      } else if (mandatoryValue.has(flag)) {
         if (args[index + 1] === undefined) {
            onError(`Missing value for ${flag}`);
         }
         index += 1;
      } else if (optionalValue.has(flag)) {
         if (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
            index += 1;
         }
      } else if (presenceOnly.has(flag)) {
         // Nothing to claim; the analyzer reads its presence.
      } else if (flag.startsWith('-')) {
         onError(`Unknown option: ${flag} (hydranium-cli analyze-heap --help)`);
      } else if (snapshot === undefined) {
         snapshot = flag;
      } else {
         onError(`Unexpected argument: ${flag} (hydranium-cli analyze-heap --help)`);
      }
   }
   if (!diff && snapshot === undefined) {
      onError('Missing required option: <snapshot> (hydranium-cli analyze-heap --help)');
   }
   return { diff, snapshot };
}

export function runAnalyzeHeapCommand(args: string[], deps: AnalyzeHeapDeps = {}): Promise<void> {
   if (args.length === 0) {
      // Usage on stdout and a non-zero exit, matching the parent binary's bare
      // invocation: a CI step that forgot its snapshot argument must fail rather
      // than read a help page as a completed analysis.
      printHelp(ANALYZE_HEAP_HELP);
      process.exitCode = 1;
      return Promise.resolve();
   }
   if (helpRequested(args, ANALYZE_HEAP_VALUE_FLAGS)) {
      printHelp(ANALYZE_HEAP_HELP);
      return Promise.resolve();
   }
   parseAnalyzeHeapArgs(args);
   return runAnalyzeHeap(args, deps);
}
