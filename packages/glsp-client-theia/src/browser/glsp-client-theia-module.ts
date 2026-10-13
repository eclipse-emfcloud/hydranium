/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type BindingContext, DiagramLoader } from '@eclipse-glsp/client';
import {
   bindChannelLogger,
   ChannelLogger,
   type ChannelLoggerOptions,
   ChannelTracer,
   getRequestParentName
} from '@hydranium/client-theia/browser';
import { Clock } from '@hydranium/client-theia/common';
import { createGlspClientModule, HydraniumClientTypes } from '@hydranium/glsp-client';
import { SystemClock } from '@hydranium/protocol';
import { bindHydraniumGlspMessageService } from './glsp-message-service';
import { HydraniumGlspTheiaDiagramLoader } from './theia-diagram-loader';

/** Options for `createGlspClientTheiaModule`. The adopter supplies the channel
 *  logger configuration ({@link ChannelLoggerOptions} — a `channelName`, and
 *  optionally a `component` label); the framework owns the dispatcher type and
 *  the `ChannelLogger` binding. The log threshold is not configured here — it
 *  is process-global, driven by `bindLogLevelPreference` or by
 *  `AbstractHydraniumGlspTheiaFrontendModule.logLevelPreference`. */
export interface GlspClientTheiaModuleOptions {
   readonly channelLogger: ChannelLoggerOptions;
}

/**
 * Composes the standard framework client bindings for a Theia frontend: the
 * cross-head Output-channel logger, the host-neutral classes
 * `createGlspClientModule` binds, fed from that channel, the loader that renders
 * its failure through Theia's catalogue, and the message service that drops
 * the duplicate model-loading notification.
 *
 * The neutral tokens are bound BEFORE the neutral binder runs, so it binds no
 * console defaults. The logger binding tags each line with the requesting
 * class, as `bindChannelLogger`'s own does; a plain `toService` alias would
 * start a fresh request and lose the tag. The clock is resolved lazily, so a
 * clock an adopter module binds after this one is still the one used.
 *
 * Takes the whole {@link BindingContext} rather than `(bind, rebind)`: the
 * message-service rebind has to know whether GLSP's `theiaNotificationModule`
 * already bound its token, and a container-module body has the full context to
 * hand anyway.
 *
 * Every binding is unconditional, with no per-feature flags. Each replaces a
 * GLSP default with a strict superset of its behaviour, so a head that wants
 * the original rebinds that one token back — the same one-line move this
 * function makes.
 *
 * Adopter composition roots call this first; adopter-specific bindings
 * (diagram-module rebinds, custom tools, etc.) layer on top.
 */
export function createGlspClientTheiaModule(context: BindingContext, options: GlspClientTheiaModuleOptions): void {
   const { bind, isBound, rebind } = context;
   bindChannelLogger(bind, options.channelLogger);
   bind(HydraniumClientTypes.Logger).toDynamicValue(ctx => {
      const base = ctx.container.get(ChannelLogger);
      const parentName = getRequestParentName(ctx);
      return parentName ? base.for(parentName) : base;
   });
   bind(HydraniumClientTypes.Tracer).toService(ChannelTracer);
   bind(HydraniumClientTypes.Clock)
      .toDynamicValue(ctx => (ctx.container.isBound(Clock) ? ctx.container.get<Clock>(Clock) : new SystemClock()))
      .inSingletonScope();
   createGlspClientModule(context);
   rebind(DiagramLoader).to(HydraniumGlspTheiaDiagramLoader).inSingletonScope();
   bindHydraniumGlspMessageService(bind, isBound, rebind);
}
