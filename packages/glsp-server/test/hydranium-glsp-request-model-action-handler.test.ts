/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { HydraniumGlspRequestModelActionHandler } from '../src/status/hydranium-glsp-request-model-action-handler.js';
import { DiagramStatus } from '../src/state/diagram-status.js';

class ProbeHandler extends HydraniumGlspRequestModelActionHandler {
   load(): void {
      this.reportModelLoading('Upstream English');
   }
   finish(): void {
      this.reportModelLoadingFinished();
   }
}

describe('HydraniumGlspRequestModelActionHandler', () => {
   it('renders loading once for both status and progress and clears the status on completion', () => {
      const statuses: unknown[][] = [];
      const progress: string[] = [];
      const handler = new ProbeHandler();
      Object.assign(handler, {
         sharedServices: { MessageRenderer: { renderMessage: (message: { code: string }) => `translated: ${message.code}` } },
         modelState: { setStatus: (...args: unknown[]) => statuses.push(args) },
         progressService: {
            start: (message: string) => {
               progress.push(message);
            }
         }
      });
      handler.load();
      expect(statuses).toEqual([
         [DiagramStatus.MODEL_LOAD, { message: 'translated: hydranium/glsp-server/diagram-loading', severity: 'INFO' }]
      ]);
      expect(progress).toEqual(['translated: hydranium/glsp-server/diagram-loading']);
      handler.finish();
      expect(statuses[1]).toEqual([DiagramStatus.MODEL_LOAD, undefined]);
   });
});
