/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs asset, no type declarations
import { langiumClassifier } from '../heap-analysis/heap/langium/langium.classifier.mjs';

/** Minimal heap-node stub: an object with string-valued own properties. */
function node(name: string, properties: Record<string, string>): unknown {
   const references = Object.entries(properties).map(([property, value]) => ({
      type: 'property',
      name_or_index: property,
      is_index: false,
      toNode: { type: 'string', name: value, references: [] }
   }));
   return { type: 'object', name, references };
}

const payload = { name: 'Element', type: 'TypeOne', documentUri: 'file:///a.x', path: '/elements@0' };

describe('langiumClassifier descriptions', () => {
   it('labels a literal description payload by its element kind', () => {
      expect(langiumClassifier.classify(node('Object', { ...payload, node: '', nameSegment: '', selectionSegment: '' }))).toBe(
         'AstNodeDescription:base:TypeOne'
      );
   });

   it('labels a class-instance payload without own segments the same way', () => {
      expect(langiumClassifier.classify(node('TypeOneAstNodeDescription', payload))).toBe('AstNodeDescription:base:TypeOne');
   });

   it('labels a wrapper class without payload fields by its scope layer', () => {
      expect(langiumClassifier.classify(node('LocalAstNodeDescription', { name: 'Element' }))).toBe('AstNodeDescription:Local');
   });
});
