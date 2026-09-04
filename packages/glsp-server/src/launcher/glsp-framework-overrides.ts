/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger as GlspLogger, LoggerFactory, getRequestParentName } from '@eclipse-glsp/server';
import { ContainerModule } from 'inversify';
import type { ServerSharedServices } from '@hydranium/core';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * The framework bindings layered on top of GLSP's own app module, shared by
 * every bringup regardless of transport.
 *
 * Two things happen here. GLSP's `Logger` / `LoggerFactory` are replaced with
 * the adopter's — unbind-then-bind, the same pattern `createAppModule` uses
 * internally — so GLSP server logs leave through the adopter's sink rather than
 * a console the host may not own. And `HydraniumTypes.Tracer` is added,
 * caller-tagged the same way the logger is, so an injected tracer's timing lines
 * carry the requesting class's component without every call site naming itself.
 *
 * **Shared rather than written once per launcher, because the two would drift
 * silently.** A transport-specific copy that fell behind would still bind
 * something for each symbol, so nothing would fail — the head would merely log
 * or trace differently depending on how it was started, which no test asks
 * about.
 *
 * `createLogger` is called once per Inversify resolution, with `caller` set to
 * the requesting parent's class name, and once per `LoggerFactory` invocation.
 */
export function createGlspFrameworkOverrides(createLogger: (caller?: string) => GlspLogger): ContainerModule {
   return new ContainerModule((bind, unbind, isBound) => {
      if (isBound(GlspLogger)) {
         unbind(GlspLogger);
      }
      if (isBound(LoggerFactory)) {
         unbind(LoggerFactory);
      }
      bind(GlspLogger).toDynamicValue(ctx => createLogger(getRequestParentName(ctx)));
      bind(LoggerFactory).toFactory(() => (caller: string) => createLogger(caller));
      bind(HydraniumTypes.Tracer).toDynamicValue(ctx => {
         const tracer = ctx.container.get<ServerSharedServices>(HydraniumTypes.SharedCoreServices).Tracer;
         const caller = getRequestParentName(ctx);
         return caller ? tracer.for(caller) : tracer;
      });
   });
}
