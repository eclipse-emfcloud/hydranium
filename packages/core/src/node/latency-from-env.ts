/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, LatencyCollector } from '@hydranium/protocol';

/**
 * Env flag that installs the per-method latency seam. Its presence (any
 * non-empty value) is the switch; unset means {@link latencyFromEnv} returns
 * `undefined` and the head never wires the collector — so the RPC binder, the
 * data-server and the LSP decorator all stay on their zero-cost paths.
 *
 * The {@link LatencyCollector} keeps every sample for exact percentiles, sized
 * for a bounded diagnostics window rather than always-on production telemetry;
 * gating it behind an explicit flag keeps a long-lived head from accumulating
 * samples it will never read. Mirrors `HYDRANIUM_PROFILE_E2E`.
 */
export const DEFAULT_LATENCY_ENV = 'HYDRANIUM_LATENCY';

/** True when the latency env flag is set to a non-empty value. */
export function isLatencyEnabled(): boolean {
   return !!process.env[DEFAULT_LATENCY_ENV];
}

/**
 * A {@link LatencyCollector} when {@link DEFAULT_LATENCY_ENV} is set, otherwise
 * `undefined`. Heads pass the result straight to `instrumentLspConnection`, the
 * `DataServer` `latency` option and the RPC binder; all three treat `undefined`
 * as "seam off", so this single factory is the one place a head decides whether
 * timing runs. `clock` is forwarded to the collector so tests stay deterministic.
 */
export function latencyFromEnv(clock?: Clock): LatencyCollector | undefined {
   return isLatencyEnabled() ? new LatencyCollector(clock) : undefined;
}
