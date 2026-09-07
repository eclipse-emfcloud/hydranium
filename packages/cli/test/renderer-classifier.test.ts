/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
// The analyzer ships as bundled ESM assets under heap-analysis/ (not the tsc lib);
// import the renderer classifier directly to unit-test its pure classify() branches
// without pulling in memlab or loading a real snapshot.
// @ts-expect-error -- .mjs asset, no type declarations
import { rendererClassifiers } from '../heap-analysis/heap/renderer/renderer.mjs';

/** Minimal heap-node stub — only the fields the renderer classifier reads. */
function node(type: string, name: string, references: unknown[] = []): unknown {
   return { type, name, references };
}

describe('rendererClassifiers', () => {
   const { classify, isAnchorConcept } = rendererClassifiers();

   it('buckets a live DOM element by its class, dropping the URL suffix', () => {
      expect(classify(node('native', 'HTMLDivElement'))).toBe('DOM node:HTMLDivElement');
      expect(classify(node('native', 'Window / https://example.test/app'))).toBe('DOM node:Window');
   });

   it('buckets a detached DOM node under Detached DOM', () => {
      expect(classify(node('native', 'Detached HTMLDivElement'))).toBe('Detached DOM:HTMLDivElement');
      expect(classify(node('native', 'Detached InternalNode'))).toBe('Detached DOM:InternalNode');
   });

   it('normalizes an element descriptor to a CSS selector (no raw HTML, colons, or pipes in the label)', () => {
      // Raw `<…>` markup would be eaten as HTML by a Markdown renderer, inline-style
      // colons would split the label path, and `|` would break the table column.
      expect(classify(node('native', '<div class="app-widget" id="sample.view">'))).toBe('DOM node:div#sample.view.app-widget');
      expect(classify(node('native', 'Detached <td class="item-row" style="min-width: 90px; width: 80px;">'))).toBe(
         'Detached DOM:td.item-row'
      );
      const label = classify(node('native', '<td class="a b" style="x: 1|2;">')) as string;
      expect(label).toBe('DOM node:td.a.b');
      expect(label).not.toMatch(/[<>|"]/);
      // exactly one colon — the concept/segment separator — so it stays a 2-level path
      expect(label.split(':')).toHaveLength(2);
   });

   it('routes V8 system natives to V8 native (not DOM), keyed by subtype', () => {
      expect(classify(node('native', 'system / Context'))).toBe('V8 native:Context');
      expect(classify(node('native', 'system / JSArrayBufferData'))).toBe('V8 native:JSArrayBufferData');
      expect(classify(node('native', 'system'))).toBe('V8 native:(other)');
   });

   it('classifies object-typed event listeners', () => {
      expect(classify(node('object', 'V8EventListener'))).toBe('Event listener');
      expect(classify(node('object', 'EventListener'))).toBe('Event listener');
   });

   it('delegates non-DOM nodes to the engine baseline (strings, arrays, closures)', () => {
      expect(classify(node('string', ''))).toBe('string');
      expect(classify(node('array', ''))).toBe('array (backing)');
      expect(classify(node('closure', 'someFn'))).toBe('closure');
   });

   it('anchors the DOM concepts (so they get exclusive-retained attribution + retainer paths)', () => {
      expect(isAnchorConcept('Detached DOM:HTMLDivElement')).toBe(true);
      expect(isAnchorConcept('DOM node:Text')).toBe(true);
      expect(isAnchorConcept('V8 native:JSArrayBufferData')).toBe(true);
      expect(isAnchorConcept('Event listener')).toBe(true);
      // per-constructor class buckets are anchored (the JS-object-graph attribution view)
      expect(isAnchorConcept('class')).toBe(true);
      expect(isAnchorConcept('class:SampleWidget')).toBe(true);
      // V8/JS universals stay unanchored — attributed up to their owner
      expect(isAnchorConcept('string')).toBe(false);
      expect(isAnchorConcept('closure')).toBe(false);
   });
});
