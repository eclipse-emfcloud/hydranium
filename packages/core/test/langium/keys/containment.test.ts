/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumCoreServices } from '@hydranium/langium';
import { appendChild, removeChildren } from '../../../src/langium/keys/containment.js';
import { NameBasedKeyProvider } from '../../../src/langium/keys/name-based-key-provider.js';
import { type NameProvider } from '../../../src/langium/naming/name-provider.js';
import { makeFakeAstNode, makeNoopLogger, makeNoopTracer } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

function node(type: string, name?: string): AnyNode {
   return makeFakeAstNode(name === undefined ? { $type: type } : { $type: type, name }) as AnyNode;
}

/**
 * The provider whose constraint these helpers exist to satisfy, over a stub
 * `NameProvider` that reads a plain `name` property.
 *
 * The outcome tests below go through the real `getElementKey` rather than
 * reading the three stamped fields, because the fields are the mechanism and
 * "the node has a key" is the property. Asserting the mechanism would pass
 * against a provider that had stopped consuming it.
 */
function makeKeyProvider(): NameBasedKeyProvider {
   const nameProvider = {
      getOwnName: (candidate: AstNode) => (candidate as AnyNode).name as string | undefined,
      hasName: (candidate: AstNode) => typeof (candidate as AnyNode).name === 'string',
      nameSeparator: '.'
   } as unknown as NameProvider;
   const services = {
      references: { NameProvider: nameProvider },
      shared: { Logger: makeNoopLogger(), Tracer: makeNoopTracer() }
   } as unknown as LangiumCoreServices;
   return new NameBasedKeyProvider(services as never);
}

describe('appendChild', () => {
   it('stamps all three containment fields so a positional key can be derived', () => {
      const container = node('Root');
      const children: AnyNode[] = [];
      const child = node('Transition');

      appendChild(container, 'transitions', children, child);

      expect(child.$container).toBe(container);
      expect(child.$containerProperty).toBe('transitions');
      expect(child.$containerIndex).toBe(0);
   });

   it('indexes from the array length, so appends stay consecutive', () => {
      const container = node('Root');
      const children: AnyNode[] = [];

      appendChild(container, 'transitions', children, node('Transition'));
      appendChild(container, 'transitions', children, node('Transition'));
      appendChild(container, 'transitions', children, node('Transition'));

      expect(children.map(child => child.$containerIndex)).toEqual([0, 1, 2]);
   });

   it('returns the child, so a caller can append and use it in one expression', () => {
      const child = node('Transition');
      expect(appendChild(node('Root'), 'transitions', [], child)).toBe(child);
   });

   /**
    * The point of stamping at all: an unnamed node gets a key, and the same
    * node reached by a bare `array.push` gets none. That second expectation is
    * the one that makes this a regression test rather than a restatement —
    * `undefined` is what the GLSP index cannot address.
    */
   it('is what makes an unnamed node addressable at all', () => {
      const provider = makeKeyProvider();
      const root = node('ProcessModel', 'Fulfillment');

      const stamped = appendChild(root, 'transitions', [], node('Transition'));
      const pushed = node('Transition');

      expect(provider.getElementKey(stamped)).toBe('transitions@0');
      expect(provider.getElementKey(pushed)).toBeUndefined();
   });
});

describe('removeChildren', () => {
   it('renumbers the survivors, so a later key does not name the wrong node', () => {
      const provider = makeKeyProvider();
      const container = node('ProcessModel', 'Fulfillment');
      const children: AnyNode[] = [];
      const first = appendChild(container, 'transitions', children, node('Transition'));
      const second = appendChild(container, 'transitions', children, node('Transition'));
      const third = appendChild(container, 'transitions', children, node('Transition'));

      expect(removeChildren(children, new Set([first]))).toBe(1);

      expect(children).toEqual([second, third]);
      // The keys, not the raw indices: without the renumbering these still read
      // `@1` and `@2` while sitting at 0 and 1, so a key derived afterwards
      // names a node that is no longer there — and nothing says so.
      expect(provider.getElementKey(second)).toBe('transitions@0');
      expect(provider.getElementKey(third)).toBe('transitions@1');
   });

   it('mutates the caller array in place, because it is the AST containment list', () => {
      const container = node('Root');
      const children: AnyNode[] = [];
      const doomed = appendChild(container, 'nodes', children, node('Task'));
      const kept = appendChild(container, 'nodes', children, node('Task'));

      const sameReference = children;
      removeChildren(children, new Set([doomed]));

      expect(sameReference).toBe(children);
      expect(children).toEqual([kept]);
   });

   it('is a no-op for an empty removal set', () => {
      const container = node('Root');
      const children: AnyNode[] = [];
      appendChild(container, 'transitions', children, node('Transition'));

      expect(removeChildren(children, new Set())).toBe(0);
      expect(children).toHaveLength(1);
   });

   it('ignores entries that are not in the array', () => {
      const container = node('Root');
      const children: AnyNode[] = [];
      const kept = appendChild(container, 'transitions', children, node('Transition'));

      expect(removeChildren(children, new Set([node('Transition')]))).toBe(0);
      expect(children).toEqual([kept]);
   });

   it('removes several at once and reports the count', () => {
      const container = node('Root');
      const children: AnyNode[] = [];
      const first = appendChild(container, 'transitions', children, node('Transition'));
      const second = appendChild(container, 'transitions', children, node('Transition'));
      const third = appendChild(container, 'transitions', children, node('Transition'));

      expect(removeChildren(children, new Set([first, third]))).toBe(2);
      expect(children).toEqual([second]);
      expect(second.$containerIndex).toBe(0);
   });
});
