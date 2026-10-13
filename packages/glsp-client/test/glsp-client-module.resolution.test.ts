/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

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
import { NoopLogger, SystemClock } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { Container, ContainerModule } from 'inversify';
import { describe, expect, it } from 'vitest';
import { HydraniumGlspActionDispatcher } from '../src/action-dispatcher';
import { HydraniumDiagramLoader } from '../src/diagram-loader';
import { createGlspClientModule } from '../src/glsp-client-module';
import { HydraniumHiddenBoundsUpdater } from '../src/hidden-bounds-updater';
import { SprottyLoggerAdapter } from '../src/sprotty-logger-adapter';
import { HydraniumStatusOverlay } from '../src/status-overlay';
import { HydraniumClientTypes } from '../src/types';

/** What the dispatcher was given, which it keeps protected. */
function injectedInto(dispatcher: unknown): { hydraniumLogger: unknown; clock: unknown } {
   return dispatcher as { hydraniumLogger: unknown; clock: unknown };
}

/**
 * A real GLSP container over GLSP's own default modules, so the `@inject`
 * tokens on the moved classes are exercised by resolution: a wrong token on
 * one of them would pass the recorder-based suite and fail only on a host.
 */
function makeGlspContainer(...hostModules: ContainerModule[]): Container {
   return initializeDiagramContainer(
      new Container(),
      createDiagramOptionsModule({ clientId: 'one', diagramType: 'diagram-one', glspClientProvider: async () => ({}) as never }),
      ...hostModules
   );
}

describe('createGlspClientModule in a GLSP container', () => {
   const logger = new NoopLogger();
   const hydraniumModule = new ContainerModule((bind, unbind, isBound, rebind) => {
      createGlspClientModule({ bind, unbind, isBound, rebind }, { logger });
   });

   it('resolves the real classes through the tokens the binder replaces', () => {
      const container = makeGlspContainer(hydraniumModule);
      expect(container.get(GLSPActionDispatcher)).toBeInstanceOf(HydraniumGlspActionDispatcher);
      expect(container.get(DiagramLoader)).toBeInstanceOf(HydraniumDiagramLoader);
      expect(container.get(GLSPHiddenBoundsUpdater)).toBeInstanceOf(HydraniumHiddenBoundsUpdater);
      expect(container.get(StatusOverlay)).toBeInstanceOf(HydraniumStatusOverlay);
      expect(container.get(TYPES.ILogger)).toBeInstanceOf(SprottyLoggerAdapter);
   });

   it('hands the classes the bound logger and a system clock when none is bound', () => {
      const dispatcher = injectedInto(makeGlspContainer(hydraniumModule).get(GLSPActionDispatcher));
      expect(dispatcher.hydraniumLogger).toBe(logger);
      expect(dispatcher.clock).toBeInstanceOf(SystemClock);
   });

   it('hands the classes the clock a host binds', () => {
      const clock = makeFakeClock();
      const clockModule = new ContainerModule(bind => {
         bind(HydraniumClientTypes.Clock).toConstantValue(clock);
      });
      expect(injectedInto(makeGlspContainer(hydraniumModule, clockModule).get(GLSPActionDispatcher)).clock).toBe(clock);
   });
});
