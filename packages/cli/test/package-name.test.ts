/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { NPM_PACKAGE_NAME_REGEX, packageNameToId } from '../src/package-name.js';

describe('NPM_PACKAGE_NAME_REGEX', () => {
   it('accepts an unscoped and a scoped name', () => {
      expect(NPM_PACKAGE_NAME_REGEX.test('order-flow')).toBe(true);
      expect(NPM_PACKAGE_NAME_REGEX.test('@acme/order-flow')).toBe(true);
   });

   it('rejects an uppercase name and a bare scope', () => {
      expect(NPM_PACKAGE_NAME_REGEX.test('OrderFlow')).toBe(false);
      expect(NPM_PACKAGE_NAME_REGEX.test('@acme')).toBe(false);
   });
});

describe('packageNameToId', () => {
   it('drops the scope and Pascal-cases the remaining segments', () => {
      expect(packageNameToId('@my-org/foo-bar')).toBe('FooBar');
   });

   it('splits on every separator the npm grammar allows', () => {
      expect(packageNameToId('one.two~three-four')).toBe('OneTwoThreeFour');
   });

   it('leaves a single lowercase segment as one capitalised word', () => {
      expect(packageNameToId('bookstore')).toBe('Bookstore');
   });
});
