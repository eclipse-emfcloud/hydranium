/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { LANGUAGE_CLIENT_ID, UNKNOWN_CLIENT_ID } from '../../src/documents/client-ids.js';

describe('client-ids', () => {
   // These ids are stable routing keys: tests elsewhere compare a document's
   // author against these symbols, so a blank value would silently pass there.
   // Pin the concrete, non-empty literals here so an empty-string mutation is
   // caught at the source of truth.
   it('exposes the language-client id as a stable, non-empty literal', () => {
      expect(LANGUAGE_CLIENT_ID).toBe('language-client');
   });

   it('exposes the unknown-author fallback id as a stable, non-empty literal', () => {
      expect(UNKNOWN_CLIENT_ID).toBe('unknown');
   });

   it('keeps the two client ids distinct so routing cannot collide', () => {
      expect(LANGUAGE_CLIENT_ID).not.toBe(UNKNOWN_CLIENT_ID);
   });
});
