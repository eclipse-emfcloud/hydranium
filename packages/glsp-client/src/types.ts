/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Clock, Logger, Tracer } from '@hydranium/protocol';
import type { interfaces } from 'inversify';

/** A fresh `Symbol` cast to inversify's typed identifier, so `bind` and
 *  `@inject` sites type-check against `T` rather than `any`. */
function serviceIdentifier<T>(description: string): interfaces.ServiceIdentifier<T> {
   return Symbol(description) as interfaces.ServiceIdentifier<T>;
}

/**
 * The DI tokens the framework's client classes inject, typed by the protocol
 * interfaces so a host binds whatever implementation it has: a Theia frontend
 * binds its Output-channel logger, a page or webview a console logger. Kept in
 * a registry so a token's name cannot collide with the type it injects.
 *
 * `Logger` and `Tracer` are required, so a host that binds neither fails at
 * resolution rather than running silent; `createGlspClientModule` binds
 * defaults for a host that passes none. `Clock` is optional: the classes fall
 * back to a `SystemClock`.
 */
export const HydraniumClientTypes = {
   Logger: serviceIdentifier<Logger>('HydraniumClientLogger'),
   Tracer: serviceIdentifier<Tracer>('HydraniumClientTracer'),
   Clock: serviceIdentifier<Clock>('HydraniumClientClock')
} as const;
