/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DIAGRAM_LOAD_FAILED } from '@hydranium/glsp-client/messages';
import { nls } from '@theia/core';
import { describe, expect, it, vi } from 'vitest';
import { HydraniumGlspTheiaDiagramLoader } from '../../src/browser/theia-diagram-loader';

describe('HydraniumGlspTheiaDiagramLoader', () => {
   /**
    * The KEY, not the sentence: `nls.localize` returns the English unchanged
    * with no catalogue loaded, so a sentence assertion passes with the key
    * renamed or the call removed. The parameter is asserted too, because `{0}`
    * is what makes this one catalogue entry rather than one per error text.
    */
   it('renders the failure through its catalogue key, with the detail as a parameter', () => {
      const localize = vi.spyOn(nls, 'localize');
      new HydraniumGlspTheiaDiagramLoader().loadFailureLabel(new Error('connection refused'));
      expect(localize).toHaveBeenCalledWith(
         'hydranium/glsp-client-theia/diagram-load-failed',
         'Diagram failed to load: {0}',
         'connection refused'
      );
      localize.mockRestore();
   });

   /** The English is spelled twice, once per package; a reword of one must fail here. */
   it('spells the same English as the neutral declaration', () => {
      expect(new HydraniumGlspTheiaDiagramLoader().loadFailureLabel(new Error('connection refused'))).toBe(
         DIAGRAM_LOAD_FAILED.format({ reason: 'connection refused' })
      );
   });
});
