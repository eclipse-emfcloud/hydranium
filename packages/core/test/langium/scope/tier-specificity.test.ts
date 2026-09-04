/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type AstNodeDescription, stream, URI } from '@hydranium/langium';
import { areTierSiblings, compareTierSpecificity, dedupeTierSiblingsStream } from '../../../src/langium/scope/tier-specificity.js';
import { type DescriptionTier } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode } from '../../../src/testing/index.js';

function description(name: string, opts: { tier?: DescriptionTier; uri?: string; path?: string; node?: AstNode } = {}): AstNodeDescription {
   const value: AstNodeDescription = {
      name,
      type: 'Fake',
      documentUri: URI.parse(opts.uri ?? 'memory://test'),
      path: opts.path ?? '/' + name,
      node: opts.node
   };
   if (opts.tier !== undefined) {
      (value as unknown as Record<string, string>).tier = opts.tier;
   }
   return value;
}

describe('areTierSiblings', () => {
   it('is true for descriptions sharing a live node', () => {
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
      expect(areTierSiblings(description('a', { node, path: '/a' }), description('a.qualified', { node, path: '/other' }))).toBe(true);
   });

   it('is true for descriptions sharing documentUri + path (no live node)', () => {
      expect(areTierSiblings(description('a', { path: '/Foo' }), description('ns.a', { path: '/Foo' }))).toBe(true);
   });

   it('is false for descriptions with different paths and no shared node', () => {
      expect(areTierSiblings(description('a', { path: '/A' }), description('b', { path: '/B' }))).toBe(false);
   });

   it('is false for descriptions sharing a path but living in different documents', () => {
      // Pins the documentUri half of the key comparison: same path is not enough
      // when the documents differ and no live node is shared.
      expect(
         areTierSiblings(
            description('a', { uri: 'memory://doc-a', path: '/Foo' }),
            description('a', { uri: 'memory://doc-b', path: '/Foo' })
         )
      ).toBe(false);
   });

   it('is false when only one carries a node and paths differ', () => {
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
      expect(areTierSiblings(description('a', { node, path: '/A' }), description('b', { path: '/B' }))).toBe(false);
   });
});

describe('compareTierSpecificity', () => {
   it('ranks local < project < public < universal (more specific is negative)', () => {
      expect(compareTierSpecificity(description('a', { tier: 'local' }), description('b', { tier: 'project' }))).toBeLessThan(0);
      expect(compareTierSpecificity(description('a', { tier: 'project' }), description('b', { tier: 'public' }))).toBeLessThan(0);
      expect(compareTierSpecificity(description('a', { tier: 'public' }), description('b', { tier: 'universal' }))).toBeLessThan(0);
   });

   it('returns 0 for equal tiers', () => {
      expect(compareTierSpecificity(description('a', { tier: 'project' }), description('b', { tier: 'project' }))).toBe(0);
   });

   it('ranks untiered descriptions least specific (a tiered sibling always wins)', () => {
      expect(compareTierSpecificity(description('a', { tier: 'universal' }), description('b'))).toBeLessThan(0);
   });
});

describe('dedupeTierSiblingsStream', () => {
   it('keeps the most-specific tier-sibling per node', () => {
      const result = dedupeTierSiblingsStream(
         stream([description('ns.Foo', { tier: 'public', path: '/Foo' }), description('Foo', { tier: 'project', path: '/Foo' })])
      )
         .map(d => d.name)
         .toArray();
      expect(result).toEqual(['Foo']);
   });

   it('preserves distinct nodes (different paths)', () => {
      const result = dedupeTierSiblingsStream(
         stream([description('A', { tier: 'project', path: '/A' }), description('B', { tier: 'project', path: '/B' })])
      )
         .map(d => d.name)
         .toArray();
      expect(result.sort()).toEqual(['A', 'B']);
   });

   it('keeps the first-seen sibling when a same-tier (equally specific) sibling arrives', () => {
      // Boundary for the `< 0` strictness: two same-tier siblings for one node
      // compare equal (0). Only a STRICTLY more specific sibling may displace the
      // incumbent, so the first-seen name must win; `<= 0` would wrongly replace.
      const result = dedupeTierSiblingsStream(
         stream([description('first', { tier: 'project', path: '/Foo' }), description('second', { tier: 'project', path: '/Foo' })])
      )
         .map(d => d.name)
         .toArray();
      expect(result).toEqual(['first']);
   });

   it('holds the first-seen sibling unless a strictly more specific one arrives', () => {
      // project (rank 1) arrives first; public (rank 2) must not displace it.
      const result = dedupeTierSiblingsStream(
         stream([description('Foo', { tier: 'project', path: '/Foo' }), description('ns.Foo', { tier: 'public', path: '/Foo' })])
      )
         .map(d => d.name)
         .toArray();
      expect(result).toEqual(['Foo']);
   });
});
