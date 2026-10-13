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
// `getRequestParentName` is restated rather than loaded, since the real one
// sits in the same DOM-bound module.
const { bindChannelLoggerMock } = vi.hoisted(() => ({ bindChannelLoggerMock: vi.fn() }));
vi.mock('@hydranium/client-theia/browser', () => ({
   bindChannelLogger: bindChannelLoggerMock,
   ChannelLogger: class ChannelLogger {},
   ChannelTracer: Symbol('ChannelTracer'),
   getRequestParentName: (context: interfaces.Context) =>
      (context.currentRequest.parentRequest?.bindings[0] as { implementationType?: { name?: string } } | undefined)?.implementationType
         ?.name
}));
// Importing the real `@eclipse-glsp/theia-integration` resolves back into
// `@eclipse-glsp/client`'s TypeScript *sources* via its exports map, which the node
// test env cannot parse. Only the token's identity matters here, and mocking hands
// the same stand-in to both the module under test and this file.
vi.mock('@eclipse-glsp/theia-integration', () => ({
   TheiaGLSPMessageService: class TheiaGLSPMessageService {}
}));

import 'reflect-metadata';
import {
   createDiagramOptionsModule,
   DiagramLoader,
   GLSPActionDispatcher,
   GLSPHiddenBoundsUpdater,
   initializeDiagramContainer,
   StatusOverlay,
   TYPES
} from '@eclipse-glsp/client';
import { TheiaGLSPMessageService } from '@eclipse-glsp/theia-integration';
import { ChannelLogger, ChannelTracer } from '@hydranium/client-theia/browser';
import { Clock } from '@hydranium/client-theia/common';
import {
   HydraniumClientTypes,
   HydraniumGlspActionDispatcher,
   HydraniumHiddenBoundsUpdater,
   SprottyLoggerAdapter
} from '@hydranium/glsp-client';
import { type BindRecorder, type BindRecorderOptions, makeBindRecorder } from '@hydranium/glsp-client/testing';
import { SystemClock } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { Container, ContainerModule, inject, injectable, type interfaces } from '@theia/core/shared/inversify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlspClientTheiaModule, type GlspClientTheiaModuleOptions } from '../../src/browser/glsp-client-theia-module';
import { HydraniumGlspMessageService } from '../../src/browser/glsp-message-service';
import { HydraniumGlspTheiaDiagramLoader } from '../../src/browser/theia-diagram-loader';

const CHANNEL = { channelName: 'Test' };

/** A channel logger double whose derived loggers remember their component. */
class TaggingLogger {
   constructor(readonly component?: string) {}
   for(component: string): TaggingLogger {
      return new TaggingLogger(component);
   }
}

/** A class injecting the neutral logger token, so the per-class tag has a requester. */
@injectable()
class LoggerConsumer {
   @inject(HydraniumClientTypes.Logger) readonly logger!: TaggingLogger;
}

/**
 * A real container with GLSP's default tokens and the channel logger bound as
 * their modules would have, so the token bindings are checked by resolving
 * them. `bindChannelLogger` is mocked away, so its two bindings are stood in.
 */
function makeContainer(): Container {
   const container = new Container();
   const glspTokens: interfaces.ServiceIdentifier<unknown>[] = [
      GLSPActionDispatcher,
      DiagramLoader,
      GLSPHiddenBoundsUpdater,
      StatusOverlay,
      TYPES.ILogger,
      TheiaGLSPMessageService
   ];
   for (const token of glspTokens) {
      container.bind(token).toConstantValue({});
   }
   container.bind(ChannelLogger).toConstantValue(new TaggingLogger() as unknown as ChannelLogger);
   container.bind(ChannelTracer).toConstantValue({ time: () => undefined });
   createGlspClientTheiaModule(
      {
         bind: container.bind.bind(container),
         unbind: container.unbind.bind(container),
         isBound: container.isBound.bind(container),
         rebind: container.rebind.bind(container)
      },
      { channelLogger: CHANNEL }
   );
   return container;
}

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

   it('binds the neutral classes through createGlspClientModule', () => {
      expect(record().find('rebind', GLSPHiddenBoundsUpdater)?.chain).toEqual([
         `to(<${HydraniumHiddenBoundsUpdater.name}>)`,
         'inSingletonScope()'
      ]);
   });

   it('rebinds DiagramLoader last to the loader that renders through the catalogue', () => {
      const rebinds = record().captured.filter(entry => entry.kind === 'rebind' && entry.token === DiagramLoader);
      expect(rebinds.at(-1)?.chain).toEqual([`to(<${HydraniumGlspTheiaDiagramLoader.name}>)`, 'inSingletonScope()']);
   });

   it('binds the neutral tracer token to the channel tracer', () => {
      expect(record().find('bind', HydraniumClientTypes.Tracer)?.chain).toEqual([`toService(${ChannelTracer.toString()})`]);
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

   describe('resolved in a container', () => {
      it('gives the neutral logger token the channel logger, tagged with the requesting class', () => {
         const container = makeContainer();
         container.bind(LoggerConsumer).toSelf();
         expect(container.get(LoggerConsumer).logger.component).toBe(LoggerConsumer.name);
      });

      it('gives the neutral logger token the untagged channel logger when nothing requests it', () => {
         expect(makeContainer().get<TaggingLogger>(HydraniumClientTypes.Logger).component).toBeUndefined();
      });

      it('binds no console logger of its own, since the channel is bound first', () => {
         expect(makeContainer().get(HydraniumClientTypes.Logger)).toBeInstanceOf(TaggingLogger);
      });

      it('gives the neutral clock token a system clock when the Theia clock is unbound', () => {
         expect(makeContainer().get(HydraniumClientTypes.Clock)).toBeInstanceOf(SystemClock);
      });

      it('gives the neutral clock token the Theia clock, even one bound after this module', () => {
         const container = makeContainer();
         const clock = makeFakeClock();
         container.bind(Clock).toConstantValue(clock);
         expect(container.get(HydraniumClientTypes.Clock)).toBe(clock);
      });

      it('resolves the real classes in a GLSP container, the loader being the Theia one', () => {
         // GLSP's own default modules, so the `@inject` tokens are exercised by
         // resolution rather than asserted as recorder strings.
         const theiaModule = new ContainerModule((bind, unbind, isBound, rebind) => {
            bind(ChannelLogger).toConstantValue(new TaggingLogger() as unknown as ChannelLogger);
            bind(ChannelTracer).toConstantValue({ time: () => undefined });
            createGlspClientTheiaModule({ bind, unbind, isBound, rebind }, { channelLogger: CHANNEL });
         });
         const container = initializeDiagramContainer(
            new Container(),
            createDiagramOptionsModule({ clientId: 'one', diagramType: 'diagram-one', glspClientProvider: async () => ({}) as never }),
            theiaModule
         );
         expect(container.get(DiagramLoader)).toBeInstanceOf(HydraniumGlspTheiaDiagramLoader);
         expect(container.get(GLSPActionDispatcher)).toBeInstanceOf(HydraniumGlspActionDispatcher);
         expect(container.get(TYPES.ILogger)).toBeInstanceOf(SprottyLoggerAdapter);
      });
   });
});
