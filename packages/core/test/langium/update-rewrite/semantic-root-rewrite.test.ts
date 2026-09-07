/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type TransferElement } from '@hydranium/protocol';
import { rewriteSemanticRoot } from '../../../src/langium/update-rewrite/semantic-root-rewrite.js';

interface Root extends TransferElement {
   $type: string;
   [key: string]: unknown;
}

const KEYS = ['elementOne', 'elementTwo'] as const;

function makeRoot(slot: string, node: Record<string, unknown>): Root {
   return { $type: 'Root', [slot]: node } as Root;
}

describe('rewriteSemanticRoot', () => {
   it('applies the rewrite to the populated slot and reassembles the wrapper', () => {
      const root = makeRoot('elementOne', { $type: 'TypeOne', id: 'a' });

      const result = rewriteSemanticRoot(root, KEYS, node => ({ ...node, id: 'b' }));

      expect((result.elementOne as Record<string, unknown>).id).toBe('b');
      // The wrapper is a fresh object, but the untouched discriminator survives.
      expect(result.$type).toBe('Root');
      expect(result).not.toBe(root);
   });

   it('passes the slot name so one rewrite can branch on which semantic type it got', () => {
      const seen: string[] = [];

      rewriteSemanticRoot(makeRoot('elementTwo', { $type: 'TypeTwo' }), KEYS, (node, key) => {
         seen.push(key);
         return node;
      });

      expect(seen).toEqual(['elementTwo']);
   });

   it('returns the ARGUMENT unchanged when the rewrite is a no-op', () => {
      const root = makeRoot('elementOne', { $type: 'TypeOne', id: 'a' });

      // Identity, not deep equality: the fold over a rewrite chain must not
      // allocate a fresh root per registered rewrite that does not apply.
      expect(rewriteSemanticRoot(root, KEYS, node => node)).toBe(root);
   });

   it('returns the ARGUMENT unchanged when no slot is populated', () => {
      const root = { $type: 'Root' } as Root;

      expect(rewriteSemanticRoot(root, KEYS, () => ({ $type: 'TypeOne' }))).toBe(root);
   });

   it('never calls the rewrite when no slot is populated', () => {
      let called = false;

      rewriteSemanticRoot({ $type: 'Root' } as Root, KEYS, node => {
         called = true;
         return node;
      });

      expect(called).toBe(false);
   });

   it('ignores a slot that is present but empty, and takes the populated one', () => {
      const root = { $type: 'Root', elementOne: undefined, elementTwo: { $type: 'TypeTwo', id: 'x' } } as Root;

      const result = rewriteSemanticRoot(root, KEYS, node => ({ ...node, id: 'y' }));

      expect((result.elementTwo as Record<string, unknown>).id).toBe('y');
      expect(result.elementOne).toBeUndefined();
   });

   it('ignores a property that is not a declared semantic key', () => {
      const root = { $type: 'Root', notASemanticSlot: { $type: 'TypeOne' } } as Root;

      expect(rewriteSemanticRoot(root, KEYS, () => ({ $type: 'Rewritten' }))).toBe(root);
   });
});
