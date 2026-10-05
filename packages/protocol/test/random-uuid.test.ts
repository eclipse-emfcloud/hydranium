/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from '../src/random-uuid';

describe('randomUuid', () => {
   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('draws a distinct v4 UUID each time, outside a secure context too, where crypto has no randomUUID', () => {
      vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

      const id = randomUuid();

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(randomUuid()).not.toBe(id);
   });
});
