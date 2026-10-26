/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, DefaultAstNodeLocator } from '@hydranium/langium';
import { HydraniumAstNodeLocator } from '../../../src/langium/workspace/ast-node-locator.js';

interface TreeNode extends AstNode {
   children: TreeNode[];
   single?: TreeNode;
}

function child(container: TreeNode, property: 'children' | 'single'): TreeNode {
   const $containerIndex = property === 'single' ? undefined : container.children.length;
   const node: TreeNode = { $type: 'Element', $container: container, $containerProperty: property, $containerIndex, children: [] };
   if (property === 'single') {
      container.single = node;
   } else {
      container.children.push(node);
   }
   return node;
}

describe('HydraniumAstNodeLocator', () => {
   const root: TreeNode = { $type: 'Root', children: [] };
   child(root, 'children');
   const second = child(root, 'children');
   const single = child(second, 'single');
   const leaf = child(single, 'children');
   const locator = new HydraniumAstNodeLocator();
   const langium = new DefaultAstNodeLocator();

   it("returns Langium's path for the root, indexed, and unindexed nodes", () => {
      for (const node of [root, second, single, leaf]) {
         expect(locator.getAstNodePath(node)).toBe(langium.getAstNodePath(node));
      }
      expect(locator.getAstNodePath(leaf)).toBe('/children@1/single/children@0');
   });

   it('resolves its own path back to the node', () => {
      expect(locator.getAstNode(root, locator.getAstNodePath(leaf))).toBe(leaf);
   });
});
