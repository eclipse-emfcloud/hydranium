/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DEFAULT_LOG_LEVEL_ENV, LEVEL_ORDER, parseLogLevel, type LogThreshold } from '@hydranium/protocol';

/**
 * Validate a raw `--log-level` argument into a {@link LogThreshold}. Throws on
 * an unrecognised value so the CLI's top-level `catch` surfaces a clean error
 * and exits non-zero (mirroring how the other option parsers fail fast). Use
 * for the argv-supplied value; the resolved threshold is handed to
 * {@link logLevelEnv} to target the spawned server.
 */
export function parseLogLevelOption(raw: string): LogThreshold {
   const level = parseLogLevel(raw);
   if (!level) {
      throw new Error(`Invalid --log-level: ${raw} (expected one of: ${Object.keys(LEVEL_ORDER).join(', ')})`);
   }
   return level;
}

/**
 * Build the environment override that targets *only the spawned server's* log
 * threshold. Passed to `spawnDataServer` as `env`, it sets the same
 * `HYDRANIUM_LOG_LEVEL` variable the server reads at startup — the CLI's own
 * logging is unaffected, unlike an ambient `HYDRANIUM_LOG_LEVEL=…` that the
 * child would inherit alongside the parent. The server owns *how* log level
 * works; this only routes the CLI's request onto the channel it already reads.
 *
 * **The variable is read by `LspLogger`'s constructor**, which is bound on the
 * `Logger` slot by `createLspServerSharedModule`. A server that overrides that
 * slot with a logger of its own therefore decides for itself whether this flag
 * means anything — which is the intended seam, not a gap. A server composing no
 * head module at all binds `@hydranium/core`'s `NoopLogger` and stays silent
 * regardless, so the flag is inert against it.
 *
 * Output lands on the spawned server's **stderr**, which
 * `spawnDataServer` inherits to the user by default. It deliberately does
 * not go to stdout: that is the JSON-RPC channel, so a log line there would
 * corrupt the very request this flag was set to diagnose.
 */
export function logLevelEnv(level: LogThreshold): Record<string, string> {
   return { [DEFAULT_LOG_LEVEL_ENV]: level };
}
