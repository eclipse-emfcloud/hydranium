/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { AbstractAstReflection, type AstMetaData } from '@hydranium/langium';
import { CompositeAstReflection } from '../../src/langium/composite-ast-reflection.js';

/** A reflection over a fixed type map, standing in for one `langium-cli` run's output. */
class FixedReflection extends AbstractAstReflection {
   constructor(override readonly types: AstMetaData) {
      super();
   }
}

// Two grammars generated separately, both importing `BaseType` from a common
// grammar. Each adds a union over it, so each run's copy of `BaseType` carries
// a different super type.
const reflectionOne = new FixedReflection({
   BaseType: { name: 'BaseType', properties: { name: { name: 'name' } }, superTypes: ['TypeOne'] },
   TypeOne: { name: 'TypeOne', properties: {}, superTypes: [] },
   Element: { name: 'Element', properties: { ref: { name: 'ref', referenceType: 'BaseType' } }, superTypes: [] }
});
const reflectionTwo = new FixedReflection({
   BaseType: { name: 'BaseType', properties: { name: { name: 'name' } }, superTypes: ['TypeTwo'] },
   TypeTwo: { name: 'TypeTwo', properties: {}, superTypes: [] }
});

describe('CompositeAstReflection', () => {
   it('knows the types of every reflection it composes', () => {
      const composite = new CompositeAstReflection([reflectionOne, reflectionTwo]);

      expect(composite.getAllTypes().sort()).toEqual(['BaseType', 'Element', 'TypeOne', 'TypeTwo']);
      expect(composite.getTypeMetaData('Element').properties.ref.referenceType).toBe('BaseType');
   });

   it('keeps every super type a shared type gained in any of the grammars', () => {
      const composite = new CompositeAstReflection([reflectionOne, reflectionTwo]);

      expect(composite.isSubtype('BaseType', 'TypeOne')).toBe(true);
      expect(composite.isSubtype('BaseType', 'TypeTwo')).toBe(true);
      expect(composite.getAllSubTypes('TypeTwo').sort()).toEqual(['BaseType', 'TypeTwo']);
      expect(composite.getTypeMetaData('BaseType').properties).toEqual({ name: { name: 'name' } });
   });

   it('leaves the composed reflections untouched', () => {
      new CompositeAstReflection([reflectionOne, reflectionTwo]);

      expect(reflectionOne.types.BaseType.superTypes).toEqual(['TypeOne']);
      expect(reflectionOne.isSubtype('BaseType', 'TypeTwo')).toBe(false);
   });

   it('throws on two different types that share a name, naming the type, property and both reflections', () => {
      class ClashingReflection extends FixedReflection {}
      const clashing = new ClashingReflection({
         BaseType: { name: 'BaseType', properties: { name: { name: 'name', referenceType: 'TypeOne' } }, superTypes: [] }
      });

      expect(() => new CompositeAstReflection([reflectionOne, reflectionTwo, clashing])).toThrow(
         /reflections\[0\] \(FixedReflection\) and reflections\[2\] \(ClashingReflection\).*'BaseType'.*'name'/s
      );
   });

   it('lets a subclass replace the clash policy', () => {
      class LenientReflection extends CompositeAstReflection {
         protected override sameProperty(): boolean {
            return true;
         }
      }
      const clashing = new FixedReflection({
         BaseType: { name: 'BaseType', properties: { name: { name: 'name', referenceType: 'TypeOne' } }, superTypes: [] }
      });

      expect(new LenientReflection([reflectionOne, clashing]).getTypeMetaData('BaseType').properties.name).toEqual({ name: 'name' });
   });

   it('throws on a shared property whose default value differs', () => {
      const listOf = (defaultValue: [] | undefined): FixedReflection =>
         new FixedReflection({
            BaseType: { name: 'BaseType', properties: { members: { name: 'members', defaultValue } }, superTypes: [] }
         });

      expect(() => new CompositeAstReflection([listOf([]), listOf(undefined)])).toThrow(/'BaseType'.*'members'/s);
   });

   it('keeps a property optional when only one generator records optionality', () => {
      // langium-cli before 4.3 emits no `optional`, and writes the keys it does
      // emit in its own order.
      const newer = new FixedReflection({
         BaseType: { name: 'BaseType', properties: { members: { name: 'members', defaultValue: [], optional: true } }, superTypes: [] }
      });
      const older = new FixedReflection({
         BaseType: { name: 'BaseType', properties: { members: { defaultValue: [], name: 'members' } }, superTypes: [] }
      });

      expect(new CompositeAstReflection([older, newer]).getTypeMetaData('BaseType').properties.members.optional).toBe(true);
      expect(new CompositeAstReflection([newer, older]).getTypeMetaData('BaseType').properties.members.optional).toBe(true);
   });

   it('throws when only a later reflection gives a shared name an extra property', () => {
      const extended = new FixedReflection({
         BaseType: { name: 'BaseType', properties: { name: { name: 'name' }, members: { name: 'members' } }, superTypes: [] }
      });

      expect(() => new CompositeAstReflection([reflectionOne, extended])).toThrow(/'BaseType'.*'members'/s);
   });
});
