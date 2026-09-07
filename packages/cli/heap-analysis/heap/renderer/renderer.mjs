/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Renderer (browser) heap classification — the `--renderer` mode's counterpart to
 * the Langium/GLSP classifiers. A renderer `.heapsnapshot` (from CDP
 * `HeapProfiler.takeHeapSnapshot`, the `browser-heap` artefact) has NO Langium
 * structure; its leak vocabulary is the DOM: detached DOM subtrees and the JS
 * that retains them (event listeners, closures, arrays). So this classifier
 * buckets by that vocabulary and lets the SAME report machinery (exclusive
 * retained, holders, retainer paths) do the work — a retainer path to a
 * `Detached DOM` concept IS the listener-retainer analysis.
 *
 * Unlike a normal ConceptClassifier contribution, this cannot be composed through
 * `composeClassifiers`: DOM nodes are `native`-typed, and the engine short-circuits
 * every non-`object` node to its primitive bucket BEFORE contributions run. So the
 * renderer mode installs a dedicated `classify` that intercepts `native`/DOM nodes
 * itself and delegates everything else to the engine baseline (the JS/V8 universals
 * — strings, arrays, closures — which a renderer heap has just like any other).
 */

import { composeClassifiers } from '../langium/concepts.mjs';

const DETACHED_PREFIX = 'Detached ';
const SYSTEM_PREFIX = 'system';
/** Object-node class names V8 uses for a registered DOM event listener. */
const EVENT_LISTENER_NAMES = new Set(['V8EventListener', 'EventListener']);

/**
 * A clean, single-segment DOM key for a heap node name. V8 names a DOM element by
 * its markup or by its class (`HTMLDivElement`, `Text`). The raw markup breaks the
 * report: the `<…>` is eaten as literal HTML by a Markdown renderer, an inline
 * `style` attribute's `:` collides with the label-path separator, and a `|` would
 * break the table column. So an element descriptor is normalised to a CSS selector
 * — dropping the `style`/`data-*` soup, which also collapses near-duplicate rows —
 * and any residual `:`/`|`/`<`/`>`/`"` is stripped. A plain class name passes
 * through, and V8's trailing ` / <url>` suffix is dropped.
 */
function domClass(name) {
   const raw = (name || 'native').split(' / ')[0].trim() || 'native';
   const element = raw.match(/^<([a-zA-Z][\w-]*)([^>]*)>$/);
   let key = raw;
   if (element) {
      const tag = element[1].toLowerCase();
      const id = (element[2].match(/\bid="([^"]*)"/) ?? ['', ''])[1].trim();
      const classes = (element[2].match(/\bclass="([^"]*)"/) ?? ['', ''])[1].trim();
      const idSel = id ? `#${id}` : '';
      const classSel = classes ? `.${classes.split(/\s+/).filter(Boolean).join('.')}` : '';
      key = `${tag}${idSel}${classSel}`;
   }
   return (
      key
         .replace(/[:|<>"]/g, ' ')
         .replace(/\s+/g, ' ')
         .trim()
         .slice(0, 80) || 'native'
   );
}

/** The subtype of a V8 `system` native (`system / Context` → `Context`; bare `system` → `(other)`). */
function nativeSubtype(name) {
   const slash = name.indexOf('/');
   return slash >= 0 ? name.slice(slash + 1).trim() || '(other)' : '(other)';
}

const RENDERER_DESCRIPTIONS = {
   'Detached DOM':
      "DOM nodes no longer in the document tree but still retained by JS — the classic browser leak. Follow each concept's retainer path to the listener / closure / array holding it; that holder is the lever.",
   'DOM node':
      'Live DOM nodes still attached to the document, grouped by element class. Growth across a session (vs a stable baseline) points at accumulating UI.',
   'V8 native':
      'V8-internal native allocations (`system / Context`, `system / JSArrayBufferData`, …) — NOT DOM. Renderer memory held by the engine (contexts, ArrayBuffer backing stores), grouped by system subtype.',
   'Event listener':
      'Registered DOM event listeners (V8EventListener). A listener retaining a detached subtree is a leak; a rising count is the other classic tell.'
};

/**
 * Build the renderer classification functions in the shape the analyzer consumes
 * ({@link composeClassifiers}'s return), intercepting `native`/DOM + event-listener
 * nodes and delegating the rest to the engine baseline (no Langium/GLSP vocabulary).
 */
export function rendererClassifiers() {
   const baseline = composeClassifiers([]);
   const classify = node => {
      if (node.type === 'native') {
         const name = node.name || '';
         if (name.startsWith(DETACHED_PREFIX)) {
            return `Detached DOM:${domClass(name.slice(DETACHED_PREFIX.length))}`;
         }
         // V8-internal native allocations (`system / Context`, `system / JSArrayBufferData`,
         // …) are NOT DOM — bucket them apart so `DOM node` reflects real elements.
         if (name === SYSTEM_PREFIX || name.startsWith(`${SYSTEM_PREFIX} `) || name.startsWith(`${SYSTEM_PREFIX}/`)) {
            return `V8 native:${nativeSubtype(name)}`;
         }
         return `DOM node:${domClass(name)}`;
      }
      if (node.type === 'object' && EVENT_LISTENER_NAMES.has(node.name)) {
         return 'Event listener';
      }
      return baseline.classify(node);
   };
   // Anchor the DOM concepts AND the per-constructor `class:<Name>` buckets: a renderer
   // heap has no curated model, so class instances (widgets, models, caches, framework
   // objects) are the meaningful attribution anchors. Without this the ~1/5 of the heap
   // that is the JS object graph shows 0 exclusive retained (attributed up to GC roots);
   // anchoring per-class turns it into a "which constructor retains the most" view.
   const isAnchorConcept = label =>
      label.startsWith('Detached DOM') ||
      label.startsWith('DOM node') ||
      label.startsWith('V8 native') ||
      label === 'Event listener' ||
      label === 'class' ||
      label.startsWith('class:');
   const describe = group => RENDERER_DESCRIPTIONS[group];
   return { classify, isAnchorConcept, conceptGroup: baseline.conceptGroup, grammarTypes: new Set(), describe };
}
