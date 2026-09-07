/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The module forwards the logger wiring to `bindChannelLogger` from
// `@hydranium/client-theia/browser`; that real module loads `@theia/output` →
// `@theia/monaco` → `@lumino/widgets` (DOM globals at module load). Mocking the
// cross-head logger surface also scopes these cases to what this module owns:
// that it forwards to `bindChannelLogger`, not what that function then binds.
const { bindChannelLoggerMock } = vi.hoisted(() => ({ bindChannelLoggerMock: vi.fn() }));
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   bindChannelLogger: bindChannelLoggerMock,
   ChannelLogger: class ChannelLogger {},
   ChannelTracer: Symbol('ChannelTracer')
}));
// Importing the real `@eclipse-glsp/theia-integration` resolves back into
// `@eclipse-glsp/client`'s TypeScript *sources* via its exports map, which the node
// test env cannot parse. Only the token's identity matters here, and mocking hands
// the same stand-in to both the module under test and this file.
vi.mock('@eclipse-glsp/theia-integration', () => ({
   TheiaGLSPMessageService: class TheiaGLSPMessageService {}
}));

import { DiagramLoader, GLSPActionDispatcher, GLSPHiddenBoundsUpdater } from '@eclipse-glsp/client';
import { TheiaGLSPMessageService } from '@eclipse-glsp/theia-integration';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumGlspActionDispatcher } from '../../src/browser/action-dispatcher';
import { HydraniumDiagramLoader } from '../../src/browser/diagram-loader';
import { createGlspClientTheiaModule, type GlspClientTheiaModuleOptions } from '../../src/browser/glsp-client-theia-module';
import { HydraniumGlspMessageService } from '../../src/browser/glsp-message-service';
import { HydraniumHiddenBoundsUpdater } from '../../src/browser/hidden-bounds-updater';
import { type BindRecorder, type BindRecorderOptions, makeBindRecorder } from '../../src/testing/bind-recorder';

const CHANNEL = { channelName: 'Test' };

describe('createGlspClientTheiaModule', () => {
   beforeEach(() => {
      bindChannelLoggerMock.mockClear();
   });

   function record(
      options: GlspClientTheiaModuleOptions = { channelLogger: CHANNEL },
      recorderOptions?: BindRecorderOptions
   ): BindRecorder {
      const recorder = makeBindRecorder(recorderOptions);
      createGlspClientTheiaModule(recorder, options);
      return recorder;
   }

   it('forwards the channel logger configuration to bindChannelLogger', () => {
      const recorder = record();
      expect(bindChannelLoggerMock).toHaveBeenCalledWith(recorder.bind, CHANNEL);
   });

   it('binds HydraniumGlspActionDispatcher as a self-bound singleton', () => {
      expect(record().find('bind', HydraniumGlspActionDispatcher)?.chain).toEqual(['toSelf()', 'inSingletonScope()']);
   });

   it('rebinds GLSPActionDispatcher to point at HydraniumGlspActionDispatcher', () => {
      expect(record().find('rebind', GLSPActionDispatcher)?.chain).toEqual([`toService(<${HydraniumGlspActionDispatcher.name}>)`]);
   });

   it('rebinds DiagramLoader to the framework loader', () => {
      expect(record().find('rebind', DiagramLoader)?.chain).toEqual([`to(<${HydraniumDiagramLoader.name}>)`, 'inSingletonScope()']);
   });

   it('rebinds GLSPHiddenBoundsUpdater to the instrumented updater', () => {
      expect(record().find('rebind', GLSPHiddenBoundsUpdater)?.chain).toEqual([
         `to(<${HydraniumHiddenBoundsUpdater.name}>)`,
         'inSingletonScope()'
      ]);
   });

   it('rebinds the Theia message service so the duplicate model-loading toast is dropped', () => {
      expect(record().find('rebind', TheiaGLSPMessageService)?.chain).toEqual([
         `to(<${HydraniumGlspMessageService.name}>)`,
         'inSingletonScope()'
      ]);
   });

   it('binds the message service outright when GLSP has not bound the token', () => {
      // Models a container without `theiaNotificationModule`: rebinding an unbound
      // token throws, so the factory must bind instead.
      const recorder = record({ channelLogger: CHANNEL }, { boundTokens: [] });
      expect(recorder.find('rebind', TheiaGLSPMessageService)).toBeUndefined();
      expect(recorder.find('bind', TheiaGLSPMessageService)?.chain).toEqual([
         `to(<${HydraniumGlspMessageService.name}>)`,
         'inSingletonScope()'
      ]);
   });
});
