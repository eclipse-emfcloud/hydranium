/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { serverSharedFactory, type ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import { makeNoopSharedServices } from '../../src/testing/index.js';

describe('serverSharedFactory', () => {
   it('hands the factory the very tree the slot was called with', () => {
      const tree = makeNoopSharedServices();
      let seen: ServerSharedServicesMinimal | undefined;

      serverSharedFactory(services => {
         seen = services;
         return 'built';
      })(tree);

      // Identity, not equality: the point of the seam is that the runtime tree
      // passes through untouched — the narrowing is a type-level claim only.
      expect(seen).toBe(tree);
   });

   it('returns the factory result unchanged', () => {
      const provider = { name: 'provider' };
      expect(serverSharedFactory(() => provider)(undefined)).toBe(provider);
   });
});
