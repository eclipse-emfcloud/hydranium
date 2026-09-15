/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindConnectionResilience } from '@hydranium/client-theia/lib/browser';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { ContainerModule } from '@theia/core/shared/inversify';

/**
 * Installs the framework's reconnect hardening on the browser side.
 *
 * A `frontendPreload` entry rather than a `frontend` one, and that is the whole
 * point of the file: Theia's preloader resolves `WebSocketConnectionSource` —
 * and with it the write buffer — while loading i18n and OS settings, before any
 * frontend module runs. Rebinding from a normal frontend module compiles, loads,
 * and silently does nothing, because the instances it means to replace already
 * exist.
 *
 * `bindConnectionResilience` returns whether it installed anything; it declines
 * and warns on a Theia too old to expose the buffer binding. Nothing here acts
 * on the answer, since the app has no behaviour to vary — an adopter that does
 * can branch on it.
 *
 * The buffer size comes from `theia.frontend.config` in the app's package.json,
 * which is how a deployment on a poor network trades memory for a longer
 * survivable outage without touching code. `ApplicationConfig` carries an index
 * signature, so an arbitrary key like this one is allowed.
 */
export default new ContainerModule((_bind, _unbind, isBound, rebind) => {
   const bufferBytes = FrontendApplicationConfigProvider.get()['connectionBufferBytes'];
   bindConnectionResilience(isBound, rebind, { bufferBytes: typeof bufferBytes === 'number' ? bufferBytes : undefined });
});
