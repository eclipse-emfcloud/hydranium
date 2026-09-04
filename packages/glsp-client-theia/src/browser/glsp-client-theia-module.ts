/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindChannelLogger, type ChannelLoggerOptions } from '@hydranium/client-theia/lib/browser';
import { type BindingContext, DiagramLoader, GLSPActionDispatcher, GLSPHiddenBoundsUpdater } from '@eclipse-glsp/client';
import { HydraniumGlspActionDispatcher } from './action-dispatcher';
import { HydraniumDiagramLoader } from './diagram-loader';
import { bindHydraniumGlspMessageService } from './glsp-message-service';
import { HydraniumHiddenBoundsUpdater } from './hidden-bounds-updater';

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
 * Composes the standard framework client bindings: the cross-head Output-channel
 * logger, the instrumented action dispatcher, the failure-reporting diagram
 * loader, the instrumented hidden-bounds updater, and the message service that
 * drops the duplicate model-loading notification.
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
   bind(HydraniumGlspActionDispatcher).toSelf().inSingletonScope();
   rebind(GLSPActionDispatcher).toService(HydraniumGlspActionDispatcher);
   rebind(DiagramLoader).to(HydraniumDiagramLoader).inSingletonScope();
   rebind(GLSPHiddenBoundsUpdater).to(HydraniumHiddenBoundsUpdater).inSingletonScope();
   bindHydraniumGlspMessageService(bind, isBound, rebind);
}
