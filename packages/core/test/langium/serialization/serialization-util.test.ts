/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { isDefaultValue, isReferenceProperty } from '../../../src/langium/serialization/serialization-util.js';
import { makeFakeReflection } from '../../../src/testing/index.js';

describe('serialization-util', () => {
   describe('isReferenceProperty', () => {
      it('is true when the property metadata carries a referenceType', () => {
         const reflection = makeFakeReflection({ TypeOne: { ref: { referenceType: 'TypeTwo' } } });
         expect(isReferenceProperty(reflection, 'TypeOne', 'ref')).toBe(true);
      });

      it('is false for a non-reference property and for an unknown property', () => {
         const reflection = makeFakeReflection({ TypeOne: { name: {} } });
         expect(isReferenceProperty(reflection, 'TypeOne', 'name')).toBe(false);
         expect(isReferenceProperty(reflection, 'TypeOne', 'missing')).toBe(false);
      });
   });

   describe('isDefaultValue', () => {
      it('is true when the value equals the declared default', () => {
         const reflection = makeFakeReflection({ Flag: { active: { defaultValue: false } } });
         expect(isDefaultValue(reflection, 'Flag', 'active', false)).toBe(true);
      });

      it('is false when the value differs from the declared default', () => {
         const reflection = makeFakeReflection({ Flag: { active: { defaultValue: false } } });
         expect(isDefaultValue(reflection, 'Flag', 'active', true)).toBe(false);
      });

      it('is false when the property declares no default, even if the value is undefined', () => {
         // Pins the `defaultValue !== undefined` guard: a property with NO
         // declared default must never count as "at default", not even when the
         // candidate value is itself `undefined` — without the guard the two
         // undefineds compare equal and every unset property is skipped.
         const reflection = makeFakeReflection({ Plain: { name: {} } });
         expect(isDefaultValue(reflection, 'Plain', 'name', undefined)).toBe(false);
      });
   });
});
