/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Logger as GlspLogger } from '@eclipse-glsp/server';
import type { Logger as ConnectionLogger } from 'vscode-jsonrpc';

/**
 * A GLSP logger in the shape a `vscode-jsonrpc` connection logs to. A launcher
 * that overrides `createConnection` passes it over its injected `logger`, or
 * the connection logs to `console` or nowhere instead of the adopter's logger.
 * GLSP's logger has no `log`; the connection's `log` lines go to `info`, the
 * threshold the framework's own `Logger.log` emits at.
 */
export function createGlspConnectionLogger(logger: GlspLogger): ConnectionLogger {
   return {
      error: message => logger.error(message),
      warn: message => logger.warn(message),
      info: message => logger.info(message),
      log: message => logger.info(message)
   };
}
