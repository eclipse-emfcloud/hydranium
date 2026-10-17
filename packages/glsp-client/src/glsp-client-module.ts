/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type BindingContext,
   DiagramLoader,
   GLSPActionDispatcher,
   GLSPHiddenBoundsUpdater,
   RankedSelectMouseListener,
   StatusOverlay,
   TYPES
} from '@eclipse-glsp/client';
import { type Clock, ConsoleLogger, DefaultTracer, type Logger, SystemClock } from '@hydranium/protocol';
import { HydraniumGlspActionDispatcher } from './action-dispatcher';
import { HydraniumDiagramLoader } from './diagram-loader';
import { HydraniumHiddenBoundsUpdater } from './hidden-bounds-updater';
import { HydraniumSelectMouseListener } from './select-mouse-listener';
import { SprottyLoggerAdapter } from './sprotty-logger-adapter';
import { HydraniumStatusOverlay } from './status-overlay';
import { HydraniumClientTypes } from './types';

/** Options for {@link createGlspClientModule}. */
export interface GlspClientModuleOptions {
   /** The host's logger, bound on `HydraniumClientTypes.Logger` in place of any
    *  binding the host made. Absent, the token keeps the host's own binding, or
    *  gets a `ConsoleLogger` when it has none. */
   readonly logger?: Logger;
   /** Count the diagram edits the server has not answered yet, as
    *  `HydraniumGlspActionDispatcher.editsInFlight`, for a host that reads the
    *  count. Off by default: each edit then costs an extra request and its
    *  answer. */
   readonly trackEditsInFlight?: boolean;
}

/**
 * Binds the framework's client classes into a GLSP diagram container, whatever
 * hosts it: the instrumented action dispatcher, the failure-reporting diagram
 * loader, the route-repairing hidden-bounds updater, the status overlay that
 * stays on the page, the select listener whose plain click replaces a pending
 * selection, and a sprotty logger that reports through the host's.
 *
 * Call it from the module a host adds AFTER GLSP's defaults, since every class
 * here replaces a token those defaults bind; `rebind` on an unbound token
 * throws. A host that wants one GLSP default back rebinds that token after
 * this call, the same one-line move this function makes.
 *
 * The logger and tracer tokens are bound only when the host has not bound
 * them, so a host with a richer logger binds `HydraniumClientTypes.Logger`
 * first and passes no option. The tracer composes the bound logger and clock.
 * Bind the tokens in the container this runs in: `isBound` sees a parent
 * container's binding, which `rebind` cannot replace.
 */
export function createGlspClientModule(context: BindingContext, options: GlspClientModuleOptions = {}): void {
   const { bind, isBound, rebind } = context;
   if (options.logger) {
      (isBound(HydraniumClientTypes.Logger) ? rebind : bind)(HydraniumClientTypes.Logger).toConstantValue(options.logger);
   } else if (!isBound(HydraniumClientTypes.Logger)) {
      bind(HydraniumClientTypes.Logger).toConstantValue(new ConsoleLogger());
   }
   if (!isBound(HydraniumClientTypes.Tracer)) {
      bind(HydraniumClientTypes.Tracer)
         .toDynamicValue(ctx => {
            const logger = ctx.container.get<Logger>(HydraniumClientTypes.Logger);
            const clock = ctx.container.isBound(HydraniumClientTypes.Clock)
               ? ctx.container.get<Clock>(HydraniumClientTypes.Clock)
               : new SystemClock();
            return new DefaultTracer(logger, clock);
         })
         .inSingletonScope();
   }
   if (options.trackEditsInFlight !== undefined) {
      (isBound(HydraniumClientTypes.TrackEditsInFlight) ? rebind : bind)(HydraniumClientTypes.TrackEditsInFlight).toConstantValue(
         options.trackEditsInFlight
      );
   }
   bind(HydraniumGlspActionDispatcher).toSelf().inSingletonScope();
   rebind(GLSPActionDispatcher).toService(HydraniumGlspActionDispatcher);
   rebind(DiagramLoader).to(HydraniumDiagramLoader).inSingletonScope();
   rebind(GLSPHiddenBoundsUpdater).to(HydraniumHiddenBoundsUpdater).inSingletonScope();
   rebind(StatusOverlay).to(HydraniumStatusOverlay).inSingletonScope();
   rebind(RankedSelectMouseListener).to(HydraniumSelectMouseListener).inSingletonScope();
   rebind(TYPES.ILogger).to(SprottyLoggerAdapter).inSingletonScope();
}
