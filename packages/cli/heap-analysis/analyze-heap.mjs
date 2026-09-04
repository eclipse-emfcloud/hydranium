/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Memory-analysis CLI for Langium/grammar-based language servers.
 *
 * Loads a .heapsnapshot via memlab, classifies every node into a Langium memory
 * CONCEPT, and reports three size views that must never be conflated:
 *   - shallow (self_size): the clean additive partition (sums to 100%)
 *   - exclusive retained: dominator-attributed, non-overlapping ("what frees if
 *     this concept goes away") -- concepts act as ownership anchors
 *   - overlapping retained: the DevTools Summary number (never summed)
 * Plus an AST-by-$type breakdown and sample retainer paths to GC root.
 *
 * Spawned by the `analyze-heap` subcommand, which owns the flag list, the help
 * text and the rejection of anything outside it; see `hydranium-cli analyze-heap
 * --help`. Values are read here so the numeric coercions live beside the code
 * that consumes them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateByBucket, attributeExclusiveRetained, shortestRetainerPath } from './heap/core/aggregate.mjs';
import { holderProfiles, regroupTally } from './heap/core/holders.mjs';
import { duplicateStrings, rankReclaimable } from './heap/core/strings.mjs';
import { findCutPoints } from './heap/core/cutpoints.mjs';
import { diffAnalyses } from './heap/core/diff.mjs';
import { Report } from './heap/core/report.mjs';
import { composeClassifiers, buildHierarchy, stringProp } from './heap/langium/concepts.mjs';
import { rendererClassifiers } from './heap/renderer/renderer.mjs';
import { mb, humanBytes, pct, progress } from './heap/core/format.mjs';

const argv = process.argv.slice(2);
const flagValue = name => {
   const i = argv.indexOf(name);
   return i >= 0 ? argv[i + 1] : undefined;
};
const flagValues = name => {
   const out = [];
   for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name && argv[i + 1] !== undefined) {
         out.push(argv[i + 1]);
      }
   }
   return out;
};

// A help-only or empty argv is answered by the subcommand out of its own
// flag/help data and never forwarded here, so reaching this branch means the
// analyzer was invoked directly. Point at the surface that documents it rather
// than keeping a second copy of the help to drift, and fail on a bare invocation
// the way the parent binary does.
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
   console.error('Run `hydranium-cli analyze-heap --help` for usage.');
   process.exit(1);
}

// --diff mode: pure JSON-vs-JSON, no snapshot/memlab. Runs first and exits.
if (argv.includes('--diff')) {
   const di = argv.indexOf('--diff');
   const basePath = argv[di + 1];
   const curPath = argv[di + 2];
   if (!basePath || !curPath) {
      console.error('Usage: --diff <baseline.json> <current.json> [--threshold <pct>]');
      process.exit(2);
   }
   // `|| 5` would swallow an explicit `--threshold 0` (a 0% gate) back to the
   // default; keep 0 by only falling back on a non-finite value.
   const thresholdRaw = Number(flagValue('--threshold'));
   const thresholdPct = (Number.isFinite(thresholdRaw) ? thresholdRaw : 5) / 100;
   const baseline = JSON.parse(fs.readFileSync(basePath, 'utf8'));
   const current = JSON.parse(fs.readFileSync(curPath, 'utf8'));
   const diff = diffAnalyses(baseline, current, thresholdPct);
   const sign = bytes => (bytes >= 0 ? '+' : '') + mb(bytes);
   console.log(`\n=== Heap diff: ${basePath} -> ${curPath} ===`);
   console.log(
      `Total shallow: ${mb(diff.total.base)} -> ${mb(diff.total.cur)} (${sign(diff.total.delta)}, ${(diff.total.growthPct * 100).toFixed(1)}%)`
   );
   console.log(`\n  Concept exclusive-retained deltas:`);
   for (const { key, base: from, cur: to, delta } of diff.concepts.slice(0, 20)) {
      console.log(`  ${sign(delta).padStart(11)}   ${mb(from).padStart(9)} -> ${mb(to).padStart(9)}  ${key}`);
   }
   const astChanged = diff.ast.slice(0, 15);
   if (astChanged.length) {
      console.log(`\n  AST $type count deltas:`);
      for (const { key, base: from, cur: to, delta } of astChanged) {
         console.log(`  ${(delta >= 0 ? '+' : '') + delta}`.padStart(13) + `   ${from} -> ${to}  ${key}`);
      }
   }
   console.log(
      `\nVerdict: ${diff.regressed ? 'REGRESSED' : 'ok'} (threshold ${(diff.thresholdPct * 100).toFixed(1)}% growth of total shallow)`
   );
   process.exit(diff.regressed ? 1 : 0);
}

// Drill-downs run by default (loading the snapshot is the only real cost; the
// analyses are cheap). A flag tunes its top-N; passing 0 disables that section.
const flagCount = (name, fallback) => {
   const index = argv.indexOf(name);
   if (index < 0) {
      return fallback;
   }
   const value = Number(argv[index + 1]);
   return Number.isFinite(value) ? value : fallback;
};

const file = argv.find(arg => arg.endsWith('.heapsnapshot'));
// --holders accepts a comma-separated list (CST,Range,Map), profiled in one
// heap pass; with no value it falls back to the top model concepts (null here).
const holdersFlag = argv.includes('--holders');
const holdersRaw = holdersFlag ? flagValue('--holders') : undefined;
const holdersList = !holdersFlag
   ? []
   : holdersRaw && !holdersRaw.startsWith('-')
     ? holdersRaw
          .split(',')
          .map(name => name.trim())
          .filter(Boolean)
     : null;
// Renderer/browser heap mode — swaps the Langium/GLSP classifiers for the DOM
// vocabulary and drops the Langium-only ground-truth validation.
const rendererMode = argv.includes('--renderer');
const validateFile = rendererMode ? undefined : flagValue('--validate');
const stringsTopN = flagCount('--strings', 20);
const cutTopN = flagCount('--cutpoints', 10);
const docsTopN = flagCount('--docs', 15);
const cutpointsAll = argv.includes('--cutpoints-all');
const jsonFile = flagValue('--json');
const outFile = flagValue('--out-file');
// Max DISPLAY depth of the hierarchical breakdown; Infinity = show full depth.
// Aggregation is always depth-agnostic, so a cap only elides deeper rows.
const breakdownDepth = argv.includes('--breakdown-depth') ? flagCount('--breakdown-depth', Infinity) : Infinity;
// How many of the biggest anchor concepts get a retainer-path sample / are the
// default --holders targets. Arbitrary readability cap (loading is the real cost).
const topConceptsN = flagCount('--top-concepts', 6);
if (!file) {
   // The subcommand already demands a positional; what survives to here is a
   // positional that is not a `.heapsnapshot`, which memlab cannot load.
   console.error('No <snapshot> given. Run `hydranium-cli analyze-heap --help` for usage.');
   process.exit(1);
}

// Concept classifiers, composed in precedence order: a head's own (--classifier)
// first so they can override, the framework defaults as the base last. A
// ConceptClassifier may be the module's default export or any named export with a
// `classify(node)` function.
const pickClassifier = loaded =>
   loaded.default && typeof loaded.default.classify === 'function'
      ? loaded.default
      : Object.values(loaded).find(value => value && typeof value.classify === 'function');

// Default classifiers shipped with the framework, loaded by default — but only
// IFF their module actually loads. A shipped default that can't be imported (a
// future classifier whose optional runtime isn't installed, or one trimmed from
// the bundle) is skipped, not fatal; the run degrades to the classifiers present.
const DEFAULT_CLASSIFIER_MODULES = rendererMode ? [] : ['./heap/langium/langium.classifier.mjs', './heap/langium/glsp.classifier.mjs'];
const defaultClassifiers = [];
for (const spec of DEFAULT_CLASSIFIER_MODULES) {
   try {
      const classifier = pickClassifier(await import(new URL(spec, import.meta.url).href));
      if (classifier) {
         defaultClassifiers.push(classifier);
      } else {
         progress(`Default classifier ${spec} exports no ConceptClassifier — skipping.`);
      }
   } catch (error) {
      progress(`Default classifier ${spec} unavailable — skipping (${error.message}).`);
   }
}

// Renderer mode uses a fixed DOM classifier that must intercept native/DOM nodes
// itself, so adopter --classifier modules cannot be composed in — reject the
// combination up front instead of loading them (a load failure is fatal) and then
// silently discarding their classifications.
if (rendererMode && flagValues('--classifier').length > 0) {
   console.error('--classifier is not supported with --renderer; the renderer uses a fixed DOM classifier.');
   process.exit(1);
}

// A head adds its own with `--classifier <file>` (repeatable); an explicitly
// requested classifier that fails to load IS fatal (unlike the optional defaults).
const adopterClassifiers = [];
for (const classifierPath of flagValues('--classifier')) {
   const classifier = pickClassifier(await import(pathToFileURL(path.resolve(classifierPath)).href));
   if (!classifier) {
      console.error(`--classifier '${classifierPath}' must export a ConceptClassifier with a classify(node) function.`);
      process.exit(1);
   }
   adopterClassifiers.push(classifier);
}

// Adopter classifiers FIRST so a more specific --classifier overrides a default
// (first-match-wins); the framework defaults are the base, queried last.
// Renderer mode installs the DOM classifier (it must intercept `native`/DOM nodes
// itself — the compose engine short-circuits non-`object` nodes to their primitive
// bucket before contributions run); otherwise compose adopter + Langium/GLSP.
const { classify, isAnchorConcept, conceptGroup, grammarTypes, describe } = rendererMode
   ? rendererClassifiers()
   : composeClassifiers([...adopterClassifiers, ...defaultClassifiers]);
const classifyNode = node => classify(node);

// Dynamic-import the memlab-backed loader only on the snapshot path, so the
// --diff short-circuit above stays dependency-free (@memlab lives solely behind
// load.mjs, reached only here). The subcommand's optional-dependency guard is
// skipped for the same reason and must stay in step with this import.
const { loadHeap } = await import('./heap/core/load.mjs');
const { heap, meta } = await loadHeap(file);
const { byBucket, selfSize, domIndex, labelOfIndex } = aggregateByBucket(heap, classifyNode);

const anchors = new Set([...byBucket.keys()].filter(isAnchorConcept));
const exclusive = attributeExclusiveRetained({ selfSize, domIndex, labelOfIndex }, anchors);

// Aggregate every label into a hierarchy keyed by its `:`-delimited path. The L1
// groups ARE the concept rows; deeper levels drive the breakdown. Each tree
// node's sizes are the exact sum of its descendants' leaf buckets (the
// reconciliation invariant), so nothing is special-cased by concept name.
const hierarchy = buildHierarchy(byBucket, label => exclusive.get(label) ?? 0);
const concepts = new Map([...hierarchy].map(([group, node]) => [group, node.sizes]));

// AST $types are the L2 children of the `AST node` group — the per-$type counts
// the --json artifact records and --validate cross-checks against the live model.
const AST_GROUP = 'AST node';
const astByType = new Map([...(hierarchy.get(AST_GROUP)?.children ?? new Map())].map(([type, node]) => [type, node.sizes]));

const total = meta.totalShallowBytes;

// --json: write a stable analysis artifact (the baseline for --diff). Concept
// sizes + AST counts + total are the regression-relevant signals.
if (jsonFile) {
   const artifact = {
      meta: { snapshot: file, nodeCount: meta.nodeCount, loadSeconds: meta.loadSeconds },
      totalShallowBytes: total,
      concepts: Object.fromEntries(
         [...concepts].map(([label, sizes]) => [label, { count: sizes.count, shallow: sizes.shallow, exclusive: sizes.exclusive }])
      ),
      astByType: Object.fromEntries([...astByType].map(([type, sizes]) => [type, sizes.count]))
   };
   fs.writeFileSync(jsonFile, JSON.stringify(artifact, null, 2));
   progress(`Wrote analysis JSON to ${jsonFile}`);
}

// Concept rows = the L1 groups, sorted by the larger of shallow/exclusive so big
// rows stay near the top whether a concept is large because it OWNS memory (high
// exclusive) or because its own bytes are large (high shallow) -- otherwise owned
// leaf buckets sink misleadingly. The generic `class` group already folds the
// long tail of unclassified class instances into one row (drilled down in the
// breakdown below), so there is no separate misc bucket.
const rowWeight = sizes => Math.max(sizes.shallow, sizes.exclusive);
const rows = [...concepts].sort((a, b) => rowWeight(b[1]) - rowWeight(a[1]));

const report = new Report();
report.title('Heap memory report');
report.note(`Snapshot: \`${file}\``);
report.note(
   `${meta.nodeCount.toLocaleString()} heap nodes, ${meta.totalShallowMb} MB shallow, loaded in ${meta.loadSeconds}s. ` +
      (rendererMode
         ? 'This is the **browser/renderer process** (a `browser-heap` CDP snapshot) — bucketed by DOM vocabulary, not Langium concepts.'
         : 'This is the **language-server process only** — no other processes, native/off-heap memory, or browser heap.')
);

report.section('How to read this report');
report.note(
   '- **Shallow** — an object\'s own bytes. The clean 100% partition of the heap; use it for "share of heap".\n' +
      '- **Exclusive retained** — dominator-attributed: bytes a concept *solely* owns (freed if it goes away). ' +
      'Non-overlapping, also partitions the heap. The truer cost, because it includes owned subtrees.\n' +
      "- **Retained subtree** — the DevTools-style full dominated subtree (sum of each instance's `retainedSize`). " +
      'It **overlaps** (can exceed the heap total) — never sum it; it is for cross-referencing DevTools and cut points.\n' +
      '- **Concept vs V8 bucket** — concepts are ' +
      (rendererMode ? 'DOM (DOM node, Detached DOM, Event listener)' : 'Langium/model (CST, descriptions, Range, …)') +
      '; `string`, `array (backing)`, `boxed number`, `code` are V8 storage/runtime that mostly *hold* the ' +
      'concept data, so their bytes are attributed to the owning concept (hence ~0 exclusive).\n' +
      '- **Dominator vs referrer** (holders) — the dominator is the *immediate* exclusive owner; a generic container ' +
      '(`Array`/`Map`) shown as a dominator usually belongs to a higher concept, so follow it up. Referrers are ' +
      '*all* pointers (shared included), so high multiplicity means cutting one frees little.\n' +
      '- Sizes are binary MB. Element kinds/`$type`s are read from the heap, so the report needs no source to produce ' +
      '(use `--validate` to check them against the live model).'
);

// Summary / heap budget: the top concepts by EXCLUSIVE retained (the act-on
// metric — what frees if the concept goes away) and the single biggest leaf, so a
// reader sees the headline before the detail. Computed from the same numbers the
// tables below show, in their own (exclusive-sorted) order.
const byExclusive = [...concepts].sort((a, b) => b[1].exclusive - a[1].exclusive).filter(([, sizes]) => sizes.exclusive > 0);
const topExclusive = byExclusive.slice(0, 5);
const top5Sum = topExclusive.reduce((sum, [, sizes]) => sum + sizes.exclusive, 0);
const leaves = [];
const collectLeaves = (path, node) => {
   if (node.children.size === 0) {
      leaves.push([path, node.sizes]);
      return;
   }
   for (const [segment, child] of node.children) {
      collectLeaves(path ? `${path} > ${segment}` : path, child);
   }
};
for (const [group, node] of hierarchy) {
   collectLeaves(group, node);
}
const biggestLeaf = leaves.sort((a, b) => b[1].exclusive - a[1].exclusive)[0];

report.section('Summary');
report.note(
   'Heap budget — the concepts that own the most memory (**exclusive retained**: what frees if removed). ' +
      'Act on this column; `Shallow` and `Retained subtree` in the Concepts table are for cross-referencing only.'
);
report.table(
   ['Concept', 'Exclusive retained', '% of heap'],
   topExclusive.map(([label, sizes]) => [label, humanBytes(sizes.exclusive), pct(sizes.exclusive, total)])
);
report.note(
   `These ${topExclusive.length} account for **${humanBytes(top5Sum)} (${pct(top5Sum, total)})** of the ${meta.totalShallowMb} MB heap.` +
      (biggestLeaf
         ? ` The single biggest consumer is **${biggestLeaf[0]}** — ${humanBytes(biggestLeaf[1].exclusive)} across ` +
           `${biggestLeaf[1].count.toLocaleString()} objects; start there. The hierarchical breakdown shows where it sits; ` +
           `Duplicate strings / Cut points / Holders show the levers.`
         : '')
);

report.section('Concepts');
report.note(
   'Every heap node classified into a memory concept. **Shallow** (own bytes) is where bytes physically ' +
      'are — a clean 100% partition; use it for share of heap. **Exclusive retained** is dominator-attributed: ' +
      'who *owns* each byte (what frees if the concept goes away). The two differ because ownership flows up: a ' +
      'string owned by a richer object is counted under that owner, not under `string`. So a concept can ' +
      'have tiny shallow yet large retained (it solely owns a big subtree), and a leaf bucket owned by ' +
      'others (`string`, `array (backing)`, `boxed number`) has large shallow yet ~0 exclusive. That is attribution, ' +
      'not a violation of the per-node `retained ≥ shallow` rule. **Retained subtree** is the DevTools-style ' +
      "overlapping retained (sum of each instance's full dominated subtree) — it double-counts nested same-concept " +
      'nodes and shared sub-concepts, so **never sum this column**; it is shown to relate to DevTools and to the cut ' +
      "points (for a single-instance concept it equals that node's cut-point subtree). Rows are " +
      'sorted by the larger of shallow and exclusive.'
);
report.table(
   ['Concept', 'Shallow', 'Shallow %', 'Exclusive retained', 'Excl %', 'Retained subtree', 'Count'],
   rows.map(([label, sizes]) => [
      label,
      humanBytes(sizes.shallow),
      pct(sizes.shallow, total),
      humanBytes(sizes.exclusive),
      pct(sizes.exclusive, total),
      humanBytes(sizes.overlapping),
      sizes.count ? sizes.count.toLocaleString() : ''
   ])
);
report.note(
   rendererMode
      ? 'The renderer heap is bucketed by DOM vocabulary + V8/JS universals:\n' +
           '- **DOM node** / **Detached DOM** — live vs off-tree DOM, grouped by element class (`<div class=…>`, `Text`, ' +
           '`SVG*Element`, …). Detached is the leak signal; its retainer path names the JS holder (a listener/closure/array).\n' +
           '- **V8 native** — V8-internal native allocations, NOT DOM: `ExternalStringData` (externalized string bytes) and ' +
           '`JSArrayBufferData` (ArrayBuffer/typed-array/wasm backing stores). Often the largest concept in a renderer heap.\n' +
           '- **Event listener** — object-typed `V8EventListener`/`EventListener` (native ones surface under DOM node / ' +
           'Detached DOM by their `V8EventListener` class instead).\n' +
           '- **string** / **array (backing)** / **code** / **closure** / **hidden** / **(object shape)** — JS/V8 storage ' +
           'and runtime; large *shallow* but ~0 *exclusive* because their bytes are attributed to the object that owns them.\n' +
           '- **class** — class instances grouped by constructor (widgets, models, caches, ' +
           'framework objects); anchored, so the breakdown ranks which constructor retains the most ' +
           '(a large single-instance row like a leaked widget is the lever).\n' +
           '- **synthetic (roots)** — the GC-root node(s).'
      : 'Many rows are **V8 / system buckets**, not model concepts — they show up as large *shallow* but ~0 *exclusive* ' +
           'because their bytes are attributed to whatever model concept owns them:\n' +
           "- **string** — JS strings (names, `$type` tags, values, each file's source text).\n" +
           "- **array (backing)** — V8's *anonymous* internal element/property arrays behind objects, `Array`s and `Map`s. " +
           'It has no identity of its own; what each array *is* comes from its referrer (the property stores of ' +
           'dictionary-mode descriptions, the scope-index `Map` tables, CST child arrays). The Holders section below ' +
           'breaks down which fields back them. (Distinct from `class:Array`, which is the JS `Array` *object* itself.)\n' +
           '- **empty object {}** — plain objects with no own heap properties (e.g. GLSP layout/option bags whose numbers ' +
           'are inline). Most former members were really `Position`s and are now classified as such.\n' +
           '- **boxed number** — heap `Number`s; mostly V8-internal (offsets/lines are inline SMIs, not these).\n' +
           '- **code** / **hidden** / **(object shape)** / **closure** — compiled code, hidden classes and engine internals.\n' +
           '- **synthetic (roots)** — the synthetic GC-root node(s); appears as a dominator for anything held only from a ' +
           'root (not exclusively owned by a model concept).\n' +
           '- **class** — the catch-all for class instances no classifier claimed (Node/V8 internals, libraries); a single ' +
           'honest row, not drilled down. **Map** / **MultiMap** are generic containers (scope index, caches, the LSP ' +
           'request map) — `--holders Map` reveals which are which.\n' +
           '"dictionary-mode" = V8 fell back to a hash map for an object\'s properties (more bytes per object).'
);
// No hardcoded "CST family" rollup: satellites (Range/Position/Segment) have
// multiple owners, so family attribution must come from dominator data
// (see `--holders <concept>`), not a guessed concept list.
const exTotal = [...exclusive.values()].reduce((sum, value) => sum + value, 0);
report.note(
   `Exclusive attribution sums to ${mb(exTotal)} (== shallow total ${meta.totalShallowMb} MB), confirming a clean partition. ` +
      'Note a **Retained subtree** larger than the whole heap (e.g. `string (concatenated)`) is expected, not a bug: ' +
      "rope/cons-strings share their pieces, so summing each one's dominated subtree double-counts the shared parts — " +
      'which is exactly why that column must never be summed.'
);

// Hierarchical breakdown: one generic renderer for every concept group that has
// sub-levels (AST node -> $type, AstNodeDescription -> layer -> element kind,
// GModel -> node/edge/... -> subtype, class -> class name). No concept is named
// here -- the tree shape comes entirely from the `:`-delimited labels, and each
// parent row is exactly the sum of its children (the reconciliation invariant).
const TOP_PER_LEVEL = 25;
const sortChildren = children => [...children].sort((a, b) => rowWeight(b[1].sizes) - rowWeight(a[1].sizes));
const sumSizes = entries =>
   entries.reduce(
      (acc, [, node]) => ({
         count: acc.count + node.sizes.count,
         shallow: acc.shallow + node.sizes.shallow,
         exclusive: acc.exclusive + node.sizes.exclusive
      }),
      { count: 0, shallow: 0, exclusive: 0 }
   );
// Pre-order emit under `node` at relative path `rel` (segments BELOW the group;
// empty at the group root). Each row's label is the path relative to the group
// heading, joined by ` > `. A `(no subtype)` row carries any items whose type ends
// at this level — e.g. elements typed exactly `label` shown beside `label > entity`
// — so the visible rows still sum to the parent. Recurses to the display-depth cap
// (level = rel.length + 1); bytes beyond it roll up into the deepest shown row.
const emitBreakdownRows = (rel, node, out) => {
   if (rel.length + 2 > breakdownDepth) {
      return; // node's children would exceed the display depth
   }
   const entries = sortChildren(node.children);
   if (!entries.length) {
      return;
   }
   const here = rel.join(' > ');
   const self = {
      count: node.sizes.count - sumSizes(entries).count,
      shallow: node.sizes.shallow - sumSizes(entries).shallow,
      exclusive: node.sizes.exclusive - sumSizes(entries).exclusive
   };
   if (self.count > 0) {
      out.push([here ? `${here} (no subtype)` : '(no subtype)', self]);
   }
   for (const [segment, child] of entries.slice(0, TOP_PER_LEVEL)) {
      const childRel = [...rel, segment];
      out.push([childRel.join(' > '), child.sizes]);
      emitBreakdownRows(childRel, child, out);
   }
   const tail = entries.slice(TOP_PER_LEVEL);
   if (tail.length) {
      out.push([`${here ? here + ' > ' : ''}… ${tail.length} more`, sumSizes(tail)]);
   }
};
// Drill down only MODEL concepts — those a classifier declared an anchor. That is
// how a concept opts into the breakdown: the generic `class` fallback (and other
// V8/engine buckets) is not an anchor, so its long per-name tail of runtime/library
// classes stays one honest row in the Concepts table without a noisy drill-down.
const groupsWithChildren = [...hierarchy]
   .filter(([group, node]) => node.children.size > 0 && isAnchorConcept(group))
   .sort((a, b) => rowWeight(b[1].sizes) - rowWeight(a[1].sizes));

report.section('Hierarchical breakdown');
report.note(
   'Each anchor concept drilled into its sub-levels. A label like ' +
      (rendererMode ? '`DOM node:td.item-row` or `V8 native:JSArrayBufferData`' : '`AST node:<$type>` or `GModel:<kind>:<subtype>`') +
      ' is a hierarchy path; the analyzer aggregates at EVERY prefix, so the ' +
      'level-1 rows sum to the group total in each heading (counts and bytes reconcile). Rows show the ' +
      'path **relative to the group** (` > ` separates levels); a `(no subtype)` row holds items whose ' +
      'type ends at that level. Only anchor concepts with sub-levels appear here; flat concepts ' +
      'and the `class` fallback (unclassified V8/runtime/library instances) stay single rows in the ' +
      `Concepts table above. Each level shows its top ${TOP_PER_LEVEL} by weight (a trailing \`… N more\` ` +
      'row folds the tail).' +
      (Number.isFinite(breakdownDepth)
         ? ` Display capped at depth ${breakdownDepth} via \`--breakdown-depth\`; deeper bytes roll up into the deepest shown row.`
         : '')
);
for (const [group, node] of groupsWithChildren) {
   const out = [];
   emitBreakdownRows([], node, out);
   const description = describe(group);
   report.note(
      `**${group}** — ${node.sizes.count.toLocaleString()} nodes, ${humanBytes(node.sizes.shallow)} shallow, ` +
         `${humanBytes(node.sizes.exclusive)} exclusive retained.` +
         (description ? `\n\n${description}` : '')
   );
   // Lead with the group total (italic) so the level-1 rows below visibly sum to it.
   const totalRow = ['*Total*', node.sizes];
   report.table(
      ['Path (under ' + group + ')', 'Count', 'Shallow', 'Exclusive retained'],
      [totalRow, ...out].map(([label, sizes]) => [
         label,
         sizes.count.toLocaleString(),
         humanBytes(sizes.shallow),
         humanBytes(sizes.exclusive)
      ])
   );
}

if (validateFile) {
   const groundTruth = JSON.parse(fs.readFileSync(validateFile, 'utf8'));
   const gtByType = groundTruth.byType ?? {};
   const snapDocs = concepts.get('LangiumDocument')?.count ?? 0;
   const types = new Set([...astByType.keys(), ...Object.keys(gtByType)]);
   const matched = [];
   const grammarOnly = [];
   const snapshotOnly = []; // not grammar, not in live model -> computed/derived
   const liveOnly = [];
   for (const type of types) {
      const snap = astByType.get(type)?.count ?? 0;
      const live = gtByType[type] ?? 0;
      if (snap > 0 && live > 0) {
         matched.push([type, snap, live, snap - live]);
      } else if (snap > 0) {
         (grammarTypes.has(type) ? grammarOnly : snapshotOnly).push([type, snap]);
      } else {
         liveOnly.push([type, live]);
      }
   }
   report.section('Validation vs live model');
   report.note(
      `Validates the snapshot's classification against the live model (ground truth from ` +
         `\`hydranium-cli ast-ground-truth\`). Snapshot: ${snapDocs} LangiumDocuments. Live model: ` +
         `${groundTruth.documents} docs, ${groundTruth.totalAstNodes} AST nodes. Counts should match; ` +
         'mismatches are either misclassification or computed/derived types that exist only in the heap.'
   );
   if (Math.abs(snapDocs - (groundTruth.documents ?? 0)) > Math.max(2, snapDocs * 0.05)) {
      report.note(
         `> **WARNING:** the snapshot (${snapDocs} docs) and the ground truth (${groundTruth.documents} docs) ` +
            'look like DIFFERENT workspaces. Validation only works when the ground truth is generated from the ' +
            'SAME workspace the snapshot was captured on; otherwise every count diverges and the deltas below ' +
            "are meaningless. Re-run `hydranium-cli ast-ground-truth` on the snapshot's own workspace."
      );
   }
   report.note('**Matched model types** (delta should be ~0; `CHECK` means |delta| > 2):');
   report.table(
      ['$type', 'Snapshot', 'Live', 'Delta', 'Flag'],
      matched
         .sort((a, b) => b[1] - a[1])
         .map(([type, snap, live, delta]) => [
            type,
            snap.toLocaleString(),
            live.toLocaleString(),
            delta,
            Math.abs(delta) <= 2 ? 'ok' : 'CHECK'
         ])
   );
   if (snapshotOnly.length) {
      report.note('**Snapshot-only, not Langium grammar** — computed/derived types (in the heap, not the parsed model); investigate:');
      report.table(
         ['$type', 'Count'],
         snapshotOnly.sort((a, b) => b[1] - a[1]).map(([type, snap]) => [type, snap.toLocaleString()])
      );
   }
   if (grammarOnly.length) {
      const grammarNodes = grammarOnly.reduce((sum, [, count]) => sum + count, 0);
      report.note(
         `**Snapshot-only Langium grammar AST** (expected, set aside): ${grammarOnly.length} types, ${grammarNodes.toLocaleString()} nodes.`
      );
   }
   if (liveOnly.length) {
      report.note('**Live-model-only** (in the model, not classified in the snapshot):');
      report.table(
         ['$type', 'Count'],
         liveOnly.sort((a, b) => b[1] - a[1]).map(([type, live]) => [type, live.toLocaleString()])
      );
   }
   const drifted = matched.filter(([, , , delta]) => Math.abs(delta) > 2).length;
   report.note(
      !drifted && !snapshotOnly.length && !liveOnly.length
         ? '**Verdict: OK** — every model `$type` reconciles with the live model (no discrepancies).'
         : `**Verdict:** ${drifted} drifted, ${snapshotOnly.length} snapshot-only (computed/derived), ${liveOnly.length} live-only — see above.`
   );
}

if (stringsTopN) {
   const { byValue, totalBytes, totalNodes, skippedLong } = duplicateStrings(heap);
   const { dups, reclaimableTotal, duplicatedValues, distinctValues } = rankReclaimable(byValue);
   report.section('Duplicate strings (interning lever)');
   report.note(
      `${totalNodes.toLocaleString()} plain string nodes, ${mb(totalBytes)} (${skippedLong.toLocaleString()} long values ` +
         `skipped as non-candidates). ${distinctValues.toLocaleString()} distinct values, ${duplicatedValues.toLocaleString()} ` +
         `duplicated. V8 does not intern these, so the same value exists as many separate nodes; interning each to one copy ` +
         `would reclaim **${mb(reclaimableTotal)}** (${pct(reclaimableTotal, totalBytes)} of string bytes). ` +
         '(Concatenated strings are a separate compute-on-demand lever; memlab does not expose their value.)'
   );
   report.table(
      ['Value', 'Count', 'Per instance', 'Reclaimable'],
      dups.slice(0, stringsTopN).map(({ value, count, size, reclaimable }) => {
         const shown = value.length > 60 ? value.slice(0, 57) + '…' : value;
         return ['`' + shown.replace(/`/g, '') + '`', count.toLocaleString(), `${size} B`, mb(reclaimable)];
      })
   );
}

if (cutTopN) {
   // Runtime/engine sole-owners (Node internals, the LSP server's connection
   // context, backing arrays) dominate the raw list but are not model memory.
   // Filter them out by default so the model cut points stand out; the model is
   // a densely co-owned graph, so there are usually very few.
   const isRuntimeLabel = label =>
      label.startsWith('class:') ||
      label.startsWith('(') ||
      [
         'closure',
         'code',
         'native',
         'hidden',
         'synthetic (roots)',
         'array (backing)',
         'boxed number',
         'empty object {}',
         'other Object shape',
         'string',
         'string (concatenated)',
         'string (sliced)'
      ].includes(label);
   const raw = findCutPoints(heap, labelOfIndex, { topN: cutpointsAll ? cutTopN : 500 });
   const cuts = cutpointsAll ? raw : raw.filter(cut => !isRuntimeLabel(cut.label)).slice(0, cutTopN);
   report.section('Cut points: lightweight sole owners');
   report.note(
      'Nodes with tiny shallow but huge retained size: each is the sole owner of a large subtree, so severing ' +
         'the few references to it frees that whole subtree. `[severable]` marks ≤ 2 referrers. ' +
         (cutpointsAll
            ? 'Showing all owners including Node/V8/server runtime.'
            : 'Showing **model only** (Node/V8/server runtime filtered out — use `--cutpoints-all` to include them). ' +
              'The model is a densely co-owned graph, so there are usually very few model cut points.')
   );
   report.note(
      '**Retained subtree** here is the raw dominated subtree (full `retainedSize`) of one node, so it ' +
         "*overlaps* the Concepts table — a single owning node's subtree includes the child objects the " +
         'Concepts table credits to their own buckets. It answers "what frees if I sever this ' +
         'node", which is larger than that concept\'s partitioned exclusive retained.'
   );
   report.table(
      ['Concept', 'Held via (Holder.field)', 'Retained subtree', 'Shallow', 'Referrers', 'Severable'],
      cuts.map(({ label, retainer, shallow, retained, referrers }) => [
         label,
         retainer ? '`' + retainer + '`' : '',
         humanBytes(retained),
         humanBytes(shallow),
         String(referrers),
         referrers <= 2 ? 'yes' : ''
      ])
   );
}

// Per-document attribution is Langium-only (keys off `LangiumDocument` heap nodes);
// a renderer heap has no documents, so the section is skipped in `--renderer` mode.
if (docsTopN && !rendererMode) {
   const docs = [];
   heap.nodes.forEach(node => {
      if (conceptGroup(classifyNode(node)) !== 'LangiumDocument') {
         return;
      }
      let uri = stringProp(node, 'uri');
      if (!uri) {
         for (const edge of node.references) {
            if (edge.type === 'property' && edge.name_or_index === 'uri' && edge.toNode) {
               uri = stringProp(edge.toNode, 'path') || stringProp(edge.toNode, 'fsPath');
               break;
            }
         }
      }
      docs.push({ uri: uri || `#${node.id}`, retained: node.retainedSize });
   });
   docs.sort((a, b) => b.retained - a.retained);
   const shownDocs = docs.slice(0, docsTopN);
   // Strip the shared directory prefix so the meaningful filename is readable;
   // state the prefix once instead of repeating it on every row.
   const pathUris = shownDocs.map(doc => doc.uri).filter(uri => uri.includes('/'));
   let commonPrefix = '';
   if (pathUris.length > 1) {
      commonPrefix = pathUris.reduce((left, right) => {
         let i = 0;
         while (i < left.length && i < right.length && left[i] === right[i]) {
            i++;
         }
         return left.slice(0, i);
      });
      commonPrefix = commonPrefix.slice(0, commonPrefix.lastIndexOf('/') + 1);
   }
   const relativeUri = uri => (commonPrefix && uri.startsWith(commonPrefix) ? uri.slice(commonPrefix.length) : uri);
   report.section('Heaviest documents by exclusively-owned memory');
   report.note(
      `Top ${docsTopN} files by the memory their document node exclusively retains. Each figure is the file's own ` +
         'parse artifacts (ParseResult → AST → CST → ranges). Its descriptions are **excluded** because the scope ' +
         "index co-owns them, so this undercounts the file's full footprint and is best read as a ranking, not an absolute." +
         (commonPrefix ? `\n\nPaths are relative to \`${commonPrefix}\`.` : '')
   );
   report.table(
      ['Exclusively owned', 'Document'],
      shownDocs.map(({ uri, retained }) => [humanBytes(retained), relativeUri(uri)])
   );
}

// Sample shortest retainer path for the biggest anchor concepts: pick, per
// concept, the node with the largest retained size, then trace it to GC root.
const topConcepts = rows
   .filter(([label]) => isAnchorConcept(label))
   .slice(0, topConceptsN)
   .map(([label]) => label);
const conceptOf = node => conceptGroup(classifyNode(node));
const best = new Map(); // concept -> { node, retained }
heap.nodes.forEach(node => {
   const label = conceptOf(node);
   if (!topConcepts.includes(label)) {
      return;
   }
   const cur = best.get(label);
   if (!cur || node.retainedSize > cur.retained) {
      best.set(label, { node, retained: node.retainedSize });
   }
});
// Backing-store and engine-internal holders are pure plumbing; eliding them
// leaves the meaningful "Holder.edge" links that tell the ownership story.
const INTERNAL_HOLDERS = new Set(['(array)', 'Array', '(hidden)']);
const formatHop = hop => (hop.via.startsWith('[') ? `${hop.from}${hop.via}` : `${hop.from}.${hop.via}`);
report.section('Sample retainer paths to GC root');
report.note(
   'For the largest node of each top concept, the shortest path to a GC root, one hop per line: each ' +
      '`← Holder.edge` reads "held by Holder via edge", chaining down to the root. Array/hidden ' +
      'backing-store hops are elided so the meaningful links show. These reveal *why* a concept is held ' +
      '(e.g. everything bottoming out at the index manager means closing a file frees little).'
);
const pathBlocks = [];
for (const label of topConcepts) {
   const hit = best.get(label);
   if (!hit) {
      continue;
   }
   const hops = shortestRetainerPath(hit.node).filter(hop => !INTERNAL_HOLDERS.has(hop.from));
   const conceptExclusive = concepts.get(label)?.exclusive ?? 0;
   const lines = [`${label}  (concept owns ${humanBytes(conceptExclusive)}; one representative node)`];
   for (const hop of hops) {
      lines.push(`    ← ${formatHop(hop)}`);
   }
   pathBlocks.push(lines.join('\n'));
}
report.code(pathBlocks.join('\n\n'));

// --holders: who holds the nodes of each requested concept? Two views per
// concept -- the exclusive owner (dominator) and all referrers -- profiled in
// one heap pass. With no value, default to the top model concepts.
if (holdersFlag) {
   // Default targets: the top model concepts plus `array (backing)` — it is ~0
   // exclusive (so never a top concept) yet often the largest SHALLOW bucket, and
   // its holders reveal which fields the anonymous arrays actually back.
   const defaultTargets = [...topConcepts];
   if (concepts.has('array (backing)') && !defaultTargets.includes('array (backing)')) {
      defaultTargets.push('array (backing)');
   }
   const targets = holdersList ?? defaultTargets;
   const profiles = holderProfiles(heap, labelOfIndex, domIndex, new Set(targets), conceptGroup);
   for (const group of targets) {
      const { targetCount, targetRetained, dominators, referrers } = profiles.get(group) ?? {};
      report.section(`Holders of "${group}"`);
      if (!targetCount) {
         report.note(`No nodes classified as "${group}" — check the concept name against the Concepts table.`);
         continue;
      }
      report.note(
         `${targetCount.toLocaleString()} nodes, ${humanBytes(targetRetained)} retained subtree. **Dominator** = who ` +
            'exclusively owns each node (cut one, it frees). **Referrers** = everyone pointing at them, including ' +
            'shared refs (`__proto__` elided) — high multiplicity is why cutting a single holder frees little.'
      );
      // In holder tables keep the class NAME (don't collapse `class:Foo` → `class`):
      // when a holder is the unclassified `class` fallback, its constructor name IS
      // the useful identity (which class holds this?). Model concepts still group to
      // their first segment.
      const holderLabel = label => (label.startsWith('class:') ? label : conceptGroup(label));
      const domByGroup = regroupTally(dominators, holderLabel);
      report.note('Exclusive owner (dominator concept):');
      report.table(
         ['Owner', 'Count', 'Share'],
         [...domByGroup.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([owner, count]) => [owner, count.toLocaleString(), pct(count, targetCount)])
      );
      // Render as `Holder.edge →` so the direction is explicit: the holder owns a
      // field that points AT the profiled concept. Collapse a numeric edge name to
      // `[]` (memlab reports array-element edges as numeric names, so an array
      // backing store otherwise explodes into one row per slot: 0, 1, … 34); group
      // the holder side to its concept as usual.
      const refByGroup = regroupTally(referrers, key => {
         const at = key.indexOf('@');
         const edge = key.slice(0, at);
         const edgeDisplay = /^\d+$/.test(edge) ? '[]' : edge;
         return `${holderLabel(key.slice(at + 1))}.${edgeDisplay} → ${group}`;
      });
      const refTotal = [...refByGroup.values()].reduce((sum, count) => sum + count, 0);
      report.note(`All referrers (\`Holder.field → ${group}\` = a field of Holder points at ${group}):`);
      report.table(
         ['Referrer', 'Count', 'Share'],
         [...refByGroup.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([key, count]) => ['`' + key + '`', count.toLocaleString(), pct(count, refTotal)])
      );
   }
}

const markdown = report.toString();
process.stdout.write(markdown + '\n');
if (outFile) {
   fs.writeFileSync(outFile, markdown);
   progress(`Wrote Markdown report to ${outFile}`);
}
