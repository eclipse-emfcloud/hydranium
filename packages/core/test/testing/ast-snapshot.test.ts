/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { makeAstSnapshot } from '../../src/testing/ast-snapshot.js';

/** A minimal Langium-`Reference`-shaped value (`$refText` + `ref` satisfies `isReference`). */
function ref(target: string): unknown {
   return { $refText: target, ref: undefined, $refNode: undefined, error: undefined };
}

describe('makeAstSnapshot', () => {
   it('reduces a Reference to its $refText', () => {
      expect(makeAstSnapshot(ref('Element'))).toEqual({ $refText: 'Element' });
   });

   it('keeps $type but drops Langium-internal $-prefixed structural props', () => {
      const node = {
         $type: 'TypeOne',
         $container: { $type: 'TypeTwo' },
         $containerProperty: 'members',
         $containerIndex: 0,
         $cstNode: { offset: 12 },
         $document: { uri: 'file:///a.x' },
         name: 'Element'
      };
      expect(makeAstSnapshot(node)).toEqual({ $type: 'TypeOne', name: 'Element' });
   });

   it('drops underscore-prefixed computed AST extensions', () => {
      const node = { $type: 'TypeOne', name: 'Element', _name: 'Element', _members: [{ $type: 'TypeTwo' }] };
      expect(makeAstSnapshot(node)).toEqual({ $type: 'TypeOne', name: 'Element' });
   });

   it('recurses through arrays and nested nodes, normalising references inside them', () => {
      const node = {
         $type: 'TypeTwo',
         name: 'Element',
         imports: ['a', 'b'],
         members: [
            { $type: 'TypeOne', name: 'Element1', ref: [ref('BaseType')] },
            { $type: 'TypeOne', name: 'Element2', ref: [] }
         ]
      };
      expect(makeAstSnapshot(node)).toEqual({
         $type: 'TypeTwo',
         name: 'Element',
         imports: ['a', 'b'],
         members: [
            { $type: 'TypeOne', name: 'Element1', ref: [{ $refText: 'BaseType' }] },
            { $type: 'TypeOne', name: 'Element2', ref: [] }
         ]
      });
   });

   it('passes primitives through unchanged', () => {
      expect(makeAstSnapshot('plain')).toBe('plain');
      expect(makeAstSnapshot(42)).toBe(42);
      expect(makeAstSnapshot(true)).toBe(true);
      expect(makeAstSnapshot(undefined)).toBeUndefined();
      expect(makeAstSnapshot(null)).toBeNull();
   });

   it('is insensitive to property insertion order (structural, not key-order, equality)', () => {
      const a = { $type: 'TypeOne', name: 'Element', primitive: 'string' };
      const b = { $type: 'TypeOne', primitive: 'string', name: 'Element' };
      expect(makeAstSnapshot(a)).toEqual(makeAstSnapshot(b));
   });
});
