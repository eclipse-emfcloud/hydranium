/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Concept-classification engine: shared heap-node helpers, the primitive / plain
 * fallback (V8/JS universals, no language vocabulary), and `composeClassifiers`,
 * which folds a set of ConceptClassifier contributions into the `classify` /
 * `isAnchorConcept` / `conceptGroup` / `grammarTypes` the analyzer consumes.
 *
 * The engine knows no model vocabulary of its own — Langium and GLSP knowledge
 * live in classifier contributions loaded by default, exactly the contract an
 * adopter's `--classifier` file uses.
 */

/**
 * @typedef {Object} ConceptClassifier
 * @property {(node: import('@memlab/core').IHeapNode) => (string|undefined)} classify
 *   Map a heap node to a concept label, or `undefined` to defer to the next
 *   classifier / the engine fallback. Receives only `object`-typed nodes
 *   (primitives are the engine's baseline).
 * @property {string[]} [anchorConcepts] Concept labels this classifier owns as
 *   exclusive-retained attribution anchors.
 * @property {string[]} [grammarTypes] `$type`s from a meta-grammar that appear in
 *   the heap but not an adopter document model (e.g. Langium's own grammar AST).
 * @property {(label: string) => boolean} [isAnchor] Predicate for prefix-based
 *   anchors (e.g. `AST node:*`); supplements `anchorConcepts`.
 * @property {Record<string, string>} [descriptions] One-line explanations keyed by
 *   root group (first label segment, e.g. `GModel`, `CST`), shown under that
 *   group's heading in the hierarchical breakdown.
 *
 * A label is a `:`-delimited HIERARCHY PATH (`L1:L2:L3`, see {@link parseLabelPath}):
 * the first segment is the display group and the analyzer aggregates at every
 * prefix, so a classifier never declares a group — it just mints a path. Each
 * segment must be `:`-free (spaces are fine); ≤3 levels is the readability
 * convention, but aggregation is depth-agnostic and never truncates.
 */

/** Property-name set of a node's own named properties. */
export function propertySet(node) {
   const set = new Set();
   for (const edge of node.references) {
      if (edge.type === 'property' && !edge.is_index && edge.name_or_index !== '__proto__') {
         set.add(edge.name_or_index);
      }
   }
   return set;
}

/** Value of a string-valued property edge (e.g. the `$type` element kind). */
export function stringProp(node, name) {
   for (const edge of node.references) {
      if (edge.type === 'property' && edge.name_or_index === name) {
         const target = edge.toNode;
         if (target && (target.type === 'string' || target.type === 'concatenated string')) {
            return target.name;
         }
         return undefined;
      }
   }
   return undefined;
}

/** True when a property set contains every named property. */
export const has = (set, ...names) => names.every(name => set.has(name));

/**
 * Follow a property edge to its target object and read a string property off it
 * (one hop of dereference). Used where a discriminator lives on a referenced node
 * rather than inline — e.g. a leaf CST node's token type is `_tokenType.name`.
 */
export function derefStringProp(node, edgeName, prop) {
   for (const edge of node.references) {
      if (edge.type === 'property' && edge.name_or_index === edgeName && edge.toNode) {
         return stringProp(edge.toNode, prop);
      }
   }
   return undefined;
}

/**
 * Read a discriminator property (e.g. `$type`/`type`) as a usable label segment.
 * A concatenated/sliced string value cannot be materialized by memlab — it
 * surfaces as a placeholder like `(concatenated string)`; treat any such
 * unreadable value (and a missing one) as `unknown` rather than leaking the
 * placeholder into a concept label.
 */
export function readableType(node, name = 'type') {
   const value = stringProp(node, name);
   return value && !value.startsWith('(') ? value : 'unknown';
}

/**
 * Split a `:`-delimited label into its hierarchy segments: the first segment is
 * the display group and each deeper segment a drill-down level. ≤3 levels is the
 * convention, but parsing is depth-agnostic — it never truncates, so an adopter
 * that emits a deeper path simply gets a deeper tree (and a `:`-free label is a
 * 1-level leaf, which is always valid). Empty/blank → a single `(unknown)`
 * segment so callers always get a non-empty group.
 */
export function parseLabelPath(label) {
   const trimmed = (label ?? '').trim();
   return trimmed ? trimmed.split(':') : ['(unknown)'];
}

/**
 * Aggregate labelled buckets into a hierarchy keyed by the `:`-delimited label
 * path. EVERY prefix accumulates, so a label `A:B:C` adds its sizes to nodes `A`,
 * `A→B` and `A→B→C`; a parent's sizes are therefore exactly the sum of its
 * descendants' leaf buckets (the reconciliation invariant the report relies on).
 * Each tree node is `{ sizes: {count, shallow, exclusive, overlapping}, children:
 * Map<segment, node> }`. No concept is hardcoded — the tree shape is whatever the
 * labels imply.
 *
 * @param {Iterable<[string, {count: number, shallow: number, retainedOverlapping: number}]>} buckets
 *   `[label, byBucket-entry]` pairs (the shallow/overlapping/count view per label).
 * @param {(label: string) => number} exclusiveOf exclusive-retained bytes for a label.
 * @returns {Map<string, {sizes: object, children: Map}>} the L1 group → subtree map.
 */
export function buildHierarchy(buckets, exclusiveOf) {
   const root = new Map();
   const ensure = (map, segment) => {
      let node = map.get(segment);
      if (!node) {
         node = { sizes: { count: 0, shallow: 0, exclusive: 0, overlapping: 0 }, children: new Map() };
         map.set(segment, node);
      }
      return node;
   };
   for (const [label, entry] of buckets) {
      const exclusive = exclusiveOf(label);
      let level = root;
      for (const segment of parseLabelPath(label)) {
         const node = ensure(level, segment);
         node.sizes.count += entry.count;
         node.sizes.shallow += entry.shallow;
         node.sizes.exclusive += exclusive;
         node.sizes.overlapping += entry.retainedOverlapping;
         level = node.children;
      }
   }
   return root;
}

/** Engine baseline for non-`object` heap nodes — V8/JS universals, no vocabulary. */
function classifyPrimitive(type) {
   switch (type) {
      case 'string':
         return 'string';
      case 'concatenated string':
         return 'string (concatenated)';
      case 'sliced string':
         return 'string (sliced)';
      case 'number':
         return 'boxed number';
      case 'closure':
         return 'closure';
      case 'code':
      case 'compiled code':
         return 'code';
      case 'array':
         return 'array (backing)';
      case 'hidden':
         return 'hidden';
      case 'synthetic':
         return 'synthetic (roots)';
      case 'native':
         return 'native';
      default:
         return `(${type})`;
   }
}

/** Engine fallback for an `object` node no classifier claimed. */
function classifyObjectFallback(node) {
   if (node.name && node.name !== 'Object') {
      return `class:${node.name}`;
   }
   return propertySet(node).size === 0 ? 'empty object {}' : 'other Object shape';
}

/**
 * Fold a set of {@link ConceptClassifier} contributions into the classification
 * functions the analyzer consumes. Contributions are tried in order — first
 * non-`undefined` `classify` wins — with the engine's primitive handling before
 * them and its `class:<name>` / `other Object shape` fallback after. Anchors are
 * the union of every contribution's `anchorConcepts` plus any `isAnchor`
 * predicate; `grammarTypes` is the union of all contributions' grammar `$type`s.
 *
 * `conceptGroup` is structural, NOT contributed: a label's group is the first
 * segment of its `:`-delimited path (see {@link parseLabelPath}). Since
 * classifiers mint the label, the first segment IS the display group — there is
 * no alias/rename layer to keep in sync.
 *
 * @param {ConceptClassifier[]} contributions
 */
export function composeClassifiers(contributions) {
   const anchorSet = new Set(contributions.flatMap(contribution => contribution.anchorConcepts ?? []));
   const grammarTypes = new Set(contributions.flatMap(contribution => contribution.grammarTypes ?? []));
   // Merge group descriptions; earlier contributions win (adopter overrides default),
   // so apply defaults first and the earlier contributions last.
   const descriptions = Object.assign({}, ...[...contributions].reverse().map(contribution => contribution.descriptions ?? {}));

   const classify = node => {
      if (node.type !== 'object') {
         return classifyPrimitive(node.type);
      }
      for (const contribution of contributions) {
         const label = contribution.classify(node);
         if (label !== undefined) {
            return label;
         }
      }
      return classifyObjectFallback(node);
   };

   const isAnchorConcept = label => anchorSet.has(label) || contributions.some(contribution => contribution.isAnchor?.(label) === true);

   // The display group is structural: the first segment of the label path.
   const conceptGroup = label => parseLabelPath(label)[0];

   const describe = group => descriptions[group];

   return { classify, isAnchorConcept, conceptGroup, grammarTypes, describe };
}
