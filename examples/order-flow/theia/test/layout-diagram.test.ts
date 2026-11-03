/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import URI from '@theia/core/lib/common/uri';
import { describe, expect, it, vi } from 'vitest';
import { OrderFlowProcessDiagramManager } from '../src/browser/order-flow-process-diagram-manager';

const { open, canHandle } = vi.hoisted(() => ({ open: vi.fn(), canHandle: vi.fn((..._args: unknown[]) => 1001) }));
// The browser base loads DOM globals; observe the URI handed to its opener.
vi.mock('@hydranium/glsp-client-theia/browser', () => ({
   AbstractHydraniumGlspDiagramManager: class {
      open(...args: unknown[]): unknown {
         return open(...args);
      }
      canHandle(...args: unknown[]): unknown {
         return canHandle(...args);
      }
   }
}));

describe('OrderFlowProcessDiagramManager', () => {
   it('offers layouts below the text editor without changing the diagram language', () => {
      const manager = new OrderFlowProcessDiagramManager();
      expect(manager.canHandle(new URI('file:///a.layout'))).toBeGreaterThan(0);
      expect(manager.canHandle(new URI('file:///a.layout'))).toBeLessThan(100);
      expect(manager.canHandle(new URI('file:///a.process'))).toBe(1001);
   });

   it('opens the same process URI from either file and preserves opener options', async () => {
      const manager = new OrderFlowProcessDiagramManager();
      const options = { mode: 'activate' as const, editMode: 'readonly' };
      await manager.open(new URI('file:///a.layout'), options);
      expect(open).toHaveBeenLastCalledWith(new URI('file:///a.process'), options);
      await manager.open(new URI('file:///a.process'), options);
      expect(open).toHaveBeenLastCalledWith(new URI('file:///a.process'), options);
   });
});
