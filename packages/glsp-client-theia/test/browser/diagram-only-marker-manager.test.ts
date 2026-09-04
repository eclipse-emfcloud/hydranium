/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ExternalMarkerManager, type IActionDispatcher, type Marker } from '@eclipse-glsp/client';
import { describe, expect, it, vi } from 'vitest';
import { NoOpExternalMarkerManager } from '../../src/browser/diagram-only-marker-manager.js';

const marker: Marker = { elementId: 'e1', kind: 'error', label: 'boom', description: 'boom' };

describe('NoOpExternalMarkerManager', () => {
   it('is an ExternalMarkerManager so connectTheiaMarkerManager accepts it', () => {
      expect(new NoOpExternalMarkerManager()).toBeInstanceOf(ExternalMarkerManager);
   });

   it('does not propagate markers to Theia — setMarkers dispatches nothing', () => {
      const dispatch = vi.fn();
      const manager = new NoOpExternalMarkerManager();
      manager.connect({ dispatch } as unknown as IActionDispatcher);

      manager.setMarkers([marker], 'batch', 'file:///m/a.a');

      expect(dispatch).not.toHaveBeenCalled();
   });
});
