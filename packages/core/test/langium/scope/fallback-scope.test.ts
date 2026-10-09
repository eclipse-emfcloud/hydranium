/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNodeDescription, MapScope, type Scope } from '@hydranium/langium';
import { FallbackScope } from '../../../src/langium/scope/fallback-scope.js';
import { makeFakeDescription } from '../../../src/testing/index.js';

/** A map scope over `names`, typed `type`, that counts its `getElement` calls. */
function countingScope(type: string, ...names: string[]): { scope: Scope; lookups: string[] } {
   const lookups: string[] = [];
   const inner = new MapScope(names.map(name => makeFakeDescription(name, { type })));
   const scope: Scope = {
      getElement: (name: string): AstNodeDescription | undefined => {
         lookups.push(name);
         return inner.getElement(name);
      },
      getElements: (name: string) => inner.getElements(name),
      getAllElements: () => inner.getAllElements()
   };
   return { scope, lookups };
}

describe('FallbackScope', () => {
   it('answers from the primary scope, and asks the fallback only for a name the primary lacks', () => {
      const primary = countingScope('Primary', 'shared', 'own');
      const fallback = countingScope('Fallback', 'shared', 'extra');
      const scope = new FallbackScope(primary.scope, fallback.scope);

      expect(scope.getElement('shared')?.type).toBe('Primary');
      expect(scope.getElement('extra')?.type).toBe('Fallback');
      expect(fallback.lookups).toEqual(['extra']);
   });

   it('lists the primary scope before the fallback', () => {
      const scope = new FallbackScope(countingScope('Primary', 'a').scope, countingScope('Fallback', 'a', 'b').scope);

      expect(
         scope
            .getAllElements()
            .map(description => `${description.type}:${description.name}`)
            .toArray()
      ).toEqual(['Primary:a', 'Fallback:a', 'Fallback:b']);
      expect(
         scope
            .getElements('a')
            .map(description => description.type)
            .toArray()
      ).toEqual(['Primary', 'Fallback']);
   });
});
