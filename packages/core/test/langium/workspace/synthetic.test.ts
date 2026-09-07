/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { AstNode } from '@hydranium/langium';
import { isSyntheticNode, markSynthetic, markSyntheticTree } from '../../../src/langium/workspace/synthetic.js';
import { makeFakeAstNode } from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
   children?: FakeNode[];
}

describe('markSynthetic', () => {
   it('sets $synthetic to true on the node', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', children: [] });
      expect(node.$synthetic).toBeUndefined();
      markSynthetic(node);
      expect(node.$synthetic).toBe(true);
   });

   it('returns the same node for fluent chaining', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', children: [] });
      expect(markSynthetic(node)).toBe(node);
   });
});

describe('markSyntheticTree', () => {
   it('marks the root and every descendant', () => {
      const leaf1 = makeFakeAstNode<FakeNode>({ $type: 'Leaf', children: [] });
      const leaf2 = makeFakeAstNode<FakeNode>({ $type: 'Leaf', children: [] });
      const branch = makeFakeAstNode<FakeNode>({ $type: 'Branch', children: [leaf1, leaf2] });
      const root = makeFakeAstNode<FakeNode>({ $type: 'Root', children: [branch] });

      markSyntheticTree(root);

      expect(root.$synthetic).toBe(true);
      expect(branch.$synthetic).toBe(true);
      expect(leaf1.$synthetic).toBe(true);
      expect(leaf2.$synthetic).toBe(true);
   });
});

describe('isSyntheticNode', () => {
   it('returns true for nodes marked synthetic via markSynthetic', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', children: [] });
      markSynthetic(node);
      expect(isSyntheticNode(node)).toBe(true);
   });

   it('returns false for unmarked nodes', () => {
      expect(isSyntheticNode(makeFakeAstNode<FakeNode>({ $type: 'X', children: [] }))).toBe(false);
   });

   it('returns false for nodes carrying $synthetic: false (explicit non-synthetic)', () => {
      const node = makeFakeAstNode<FakeNode>({ $type: 'X', children: [] });
      (node as { $synthetic?: boolean }).$synthetic = false;
      expect(isSyntheticNode(node)).toBe(false);
   });
});
