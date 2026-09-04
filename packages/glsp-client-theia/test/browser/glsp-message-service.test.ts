/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `TheiaGLSPMessageService` reaches Theia's MessageService / progress APIs. The
// subclass under test only inspects actions and delegates, so a bare base with
// recording hooks is enough — and keeps the node test env free of DOM globals.
const { baseCalls } = vi.hoisted(() => ({ baseCalls: [] as Array<{ hook: string; progressId: string; title?: string }> }));
vi.mock('@eclipse-glsp/theia-integration', () => ({
   TheiaGLSPMessageService: class TheiaGLSPMessageService {
      protected startProgress(action: { progressId: string; title: string }): void {
         baseCalls.push({ hook: 'start', progressId: action.progressId, title: action.title });
      }
      protected updateProgress(action: { progressId: string }): void {
         baseCalls.push({ hook: 'update', progressId: action.progressId });
      }
      protected endProgress(action: { progressId: string }): void {
         baseCalls.push({ hook: 'end', progressId: action.progressId });
      }
   }
}));

import { EndProgressAction, StartProgressAction, UpdateProgressAction } from '@eclipse-glsp/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumGlspMessageService, MODEL_LOADING_PROGRESS_TITLE } from '../../src/browser/glsp-message-service';

/** Exposes the protected progress hooks the GLSP action handlers call. */
class TestableMessageService extends HydraniumGlspMessageService {
   handleStart(action: StartProgressAction): void {
      this.startProgress(action);
   }
   handleUpdate(action: UpdateProgressAction): void {
      this.updateProgress(action);
   }
   handleEnd(action: EndProgressAction): void {
      this.endProgress(action);
   }
}

describe('HydraniumGlspMessageService', () => {
   let service: TestableMessageService;

   beforeEach(() => {
      baseCalls.length = 0;
      service = new TestableMessageService();
   });

   it('swallows the model-loading report the diagram overlay already shows', () => {
      service.handleStart(StartProgressAction.create({ progressId: 'p1', title: MODEL_LOADING_PROGRESS_TITLE }));
      expect(baseCalls).toEqual([]);
   });

   it('drops the updates of a swallowed report', () => {
      // Forwarding an update for a progress Theia never saw start would be a
      // dangling notification.
      service.handleStart(StartProgressAction.create({ progressId: 'p1', title: MODEL_LOADING_PROGRESS_TITLE }));
      service.handleUpdate(UpdateProgressAction.create('p1', { message: 'halfway' }));
      expect(baseCalls).toEqual([]);
   });

   it('drops the completion of a swallowed report', () => {
      service.handleStart(StartProgressAction.create({ progressId: 'p1', title: MODEL_LOADING_PROGRESS_TITLE }));
      service.handleEnd(EndProgressAction.create('p1'));
      expect(baseCalls).toEqual([]);
   });

   it('forwards every other progress report untouched', () => {
      // A long-running server operation must still report normally.
      service.handleStart(StartProgressAction.create({ progressId: 'p2', title: 'Validating model' }));
      service.handleUpdate(UpdateProgressAction.create('p2', { message: 'halfway' }));
      service.handleEnd(EndProgressAction.create('p2'));
      expect(baseCalls).toEqual([
         { hook: 'start', progressId: 'p2', title: 'Validating model' },
         { hook: 'update', progressId: 'p2' },
         { hook: 'end', progressId: 'p2' }
      ]);
   });

   it('keeps the two apart when they overlap', () => {
      service.handleStart(StartProgressAction.create({ progressId: 'p1', title: MODEL_LOADING_PROGRESS_TITLE }));
      service.handleStart(StartProgressAction.create({ progressId: 'p2', title: 'Validating model' }));
      service.handleUpdate(UpdateProgressAction.create('p1', { message: 'loading' }));
      service.handleUpdate(UpdateProgressAction.create('p2', { message: 'validating' }));
      expect(baseCalls.map(call => call.progressId)).toEqual(['p2', 'p2']);
   });

   it('forgets a suppressed id once it ends, so the set cannot grow across reloads', () => {
      service.handleStart(StartProgressAction.create({ progressId: 'p1', title: MODEL_LOADING_PROGRESS_TITLE }));
      service.handleEnd(EndProgressAction.create('p1'));
      // An unrelated later report that happens to reuse the id must be forwarded.
      service.handleUpdate(UpdateProgressAction.create('p1', { message: 'unrelated' }));
      expect(baseCalls).toEqual([{ hook: 'update', progressId: 'p1' }]);
   });
});
