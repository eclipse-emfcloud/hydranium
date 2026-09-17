/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as clientIds from '../src/client-ids';
import { FRAMEWORK_CLIENT_IDS, LANGUAGE_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID, UNKNOWN_CLIENT_ID } from '../src/client-ids';

describe('client-ids', () => {
   // The literal IS the contract: it travels as `sourceClientId`, so both ends
   // compare against the string rather than against the symbol. Tests elsewhere
   // compare a document's author against these, where a blank value would
   // silently pass — so the concrete values are pinned at the source.
   it('exposes the language-client id as a stable, non-empty literal', () => {
      expect(LANGUAGE_CLIENT_ID).toBe('language-client');
   });

   it('exposes the unknown-author fallback id as a stable, non-empty literal', () => {
      expect(UNKNOWN_CLIENT_ID).toBe('unknown');
   });

   it('exposes the revert-on-close broadcast id as a stable, non-empty literal', () => {
      expect(REVERT_ON_CLOSE_CLIENT_ID).toBe('revert-on-close');
   });

   it('keeps every reserved id distinct so routing cannot collide', () => {
      expect(new Set(FRAMEWORK_CLIENT_IDS).size).toBe(FRAMEWORK_CLIENT_IDS.length);
   });

   it('lists every reserved id, so a client can check its own against the whole set', () => {
      // Read off the MODULE rather than restated, because the drift that matters
      // is a fourth sentinel declared here and left out of the list — against
      // which a hand-written expectation passes, having been updated in the same
      // edit that would have caught it.
      const declared: string[] = [];
      for (const value of Object.values(clientIds)) {
         if (typeof value === 'string') {
            declared.push(value);
         }
      }

      expect([...FRAMEWORK_CLIENT_IDS].sort()).toEqual(declared.sort());
   });
});
