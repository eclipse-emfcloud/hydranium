/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { DiagramLoader, GLSPActionDispatcher, GLSPHiddenBoundsUpdater, StatusOverlay, TYPES } from '@eclipse-glsp/client';
import { ConsoleLogger, DefaultTracer, type Logger, NoopLogger, SystemClock } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { Container, type interfaces } from 'inversify';
import { describe, expect, it } from 'vitest';
import { HydraniumGlspActionDispatcher } from '../src/action-dispatcher';
import { HydraniumDiagramLoader } from '../src/diagram-loader';
import { createGlspClientModule, type GlspClientModuleOptions } from '../src/glsp-client-module';
import { HydraniumHiddenBoundsUpdater } from '../src/hidden-bounds-updater';
import { SprottyLoggerAdapter } from '../src/sprotty-logger-adapter';
import { HydraniumStatusOverlay } from '../src/status-overlay';
import { HydraniumClientTypes } from '../src/types';
import { type BindRecorder, makeBindRecorder } from '../src/testing/bind-recorder';

/** The GLSP default tokens the binder replaces, bound as GLSP's own modules
 *  would have, so each `rebind` finds something to replace. */
const GLSP_DEFAULT_TOKENS: interfaces.ServiceIdentifier<unknown>[] = [
   GLSPActionDispatcher,
   DiagramLoader,
   GLSPHiddenBoundsUpdater,
   StatusOverlay,
   TYPES.ILogger
];

/** A real container, so the token defaults are checked by resolving them. */
function makeContainer(): Container {
   const container = new Container();
   for (const token of GLSP_DEFAULT_TOKENS) {
      container.bind(token).toConstantValue({});
   }
   return container;
}

function bindInto(container: Container, options?: GlspClientModuleOptions): void {
   createGlspClientModule(
      {
         bind: container.bind.bind(container),
         unbind: container.unbind.bind(container),
         isBound: container.isBound.bind(container),
         rebind: container.rebind.bind(container)
      },
      options
   );
}

/** The tracer's composed logger and clock, which `DefaultTracer` keeps protected. */
function partsOf(tracer: unknown): { logger: unknown; clock: unknown } {
   return tracer as { logger: unknown; clock: unknown };
}

describe('createGlspClientModule', () => {
   function record(): BindRecorder {
      const recorder = makeBindRecorder();
      createGlspClientModule(recorder);
      return recorder;
   }

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

   it('rebinds StatusOverlay to the one that keeps its element on the page', () => {
      expect(record().find('rebind', StatusOverlay)?.chain).toEqual([`to(<${HydraniumStatusOverlay.name}>)`, 'inSingletonScope()']);
   });

   it("rebinds sprotty's logger to the adapter over the host's logger", () => {
      expect(record().find('rebind', TYPES.ILogger)?.chain).toEqual([`to(<${SprottyLoggerAdapter.name}>)`, 'inSingletonScope()']);
   });

   describe('the logger token', () => {
      it('binds the logger the host passes', () => {
         const container = makeContainer();
         const logger = new NoopLogger();
         bindInto(container, { logger });
         expect(container.get(HydraniumClientTypes.Logger)).toBe(logger);
      });

      it('binds a console logger when the host passes none and bound none', () => {
         const container = makeContainer();
         bindInto(container);
         expect(container.get(HydraniumClientTypes.Logger)).toBeInstanceOf(ConsoleLogger);
      });

      it('replaces a logger the host bound with the one it passes', () => {
         // Two bindings on one token make every resolution ambiguous, so the
         // option must replace rather than add.
         const container = makeContainer();
         container.bind<Logger>(HydraniumClientTypes.Logger).toConstantValue(new NoopLogger());
         const passed = new NoopLogger();
         bindInto(container, { logger: passed });
         expect(container.get(HydraniumClientTypes.Logger)).toBe(passed);
      });

      it("leaves the host's own logger binding alone when it passes none", () => {
         const container = makeContainer();
         const own = new NoopLogger();
         container.bind<Logger>(HydraniumClientTypes.Logger).toConstantValue(own);
         bindInto(container);
         expect(container.get(HydraniumClientTypes.Logger)).toBe(own);
      });
   });

   describe('the tracer token', () => {
      it('composes a singleton tracer from the bound logger and a system clock when the host bound no clock', () => {
         const container = makeContainer();
         const logger = new NoopLogger();
         bindInto(container, { logger });
         const tracer = container.get(HydraniumClientTypes.Tracer);
         expect(tracer).toBeInstanceOf(DefaultTracer);
         expect(partsOf(tracer).logger).toBe(logger);
         expect(partsOf(tracer).clock).toBeInstanceOf(SystemClock);
         expect(container.get(HydraniumClientTypes.Tracer)).toBe(tracer);
      });

      it('composes the tracer over the clock the host bound', () => {
         const container = makeContainer();
         const clock = makeFakeClock();
         container.bind(HydraniumClientTypes.Clock).toConstantValue(clock);
         bindInto(container);
         expect(partsOf(container.get(HydraniumClientTypes.Tracer)).clock).toBe(clock);
      });

      it("leaves the host's own tracer binding alone", () => {
         const container = makeContainer();
         const own = new DefaultTracer();
         container.bind(HydraniumClientTypes.Tracer).toConstantValue(own);
         bindInto(container);
         expect(container.get(HydraniumClientTypes.Tracer)).toBe(own);
      });
   });
});
