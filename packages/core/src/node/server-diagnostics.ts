/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LogPreambleOptions, logPreamble } from '../langium/diagnostics/log-preamble.js';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { type EventLoopMonitorOptions, startEventLoopMonitor } from './event-loop-monitor.js';
import { nodeLogPreambleSections } from './log-preamble-node.js';
import { type MemoryMonitorOptions, startMemoryMonitor } from './memory-monitor.js';

export interface ServerDiagnosticsOptions {
   /**
    * Session-preamble branding + thresholds. The Node runtime/host lines and
    * monitor conventions are added automatically (see {@link nodeLogPreambleSections}),
    * so adopters supply only their branding.
    */
   preamble: Pick<LogPreambleOptions, 'productName' | 'version' | 'phaseDetailThresholdMs'>;
   /** Emit a one-shot `Initial Memory` line at startup. Default `true`. */
   logInitialMemory?: boolean;
   /** Overrides forwarded verbatim to {@link startEventLoopMonitor}. */
   eventLoop?: EventLoopMonitorOptions;
   /** Overrides forwarded verbatim to {@link startMemoryMonitor}. */
   memory?: MemoryMonitorOptions;
}

/**
 * The standard **Node** server-observability bringup: logs the session preamble
 * (with Node runtime lines), an initial memory line, and starts the event-loop +
 * heap monitors. Returns a teardown that stops both monitors.
 *
 * Node-only by nature — it owns the `perf_hooks` / `v8` monitors. A browser
 * server has no such monitors; it just calls the portable
 * {@link logPreamble} directly (no Node sections), so there is no browser
 * counterpart to wrap.
 *
 * Option groups are nested (`preamble` / `eventLoop` / `memory`) and forwarded
 * untouched to each primitive — the primitives stay usable standalone, and the
 * groups avoid colliding on shared field names (e.g. both monitors take an
 * `intervalMs`).
 */
export function startServerDiagnostics(shared: ServerSharedServicesMinimal, options: ServerDiagnosticsOptions): () => void {
   const { productName, version, phaseDetailThresholdMs } = options.preamble;
   logPreamble(shared.Logger.for('LogFormat'), {
      productName,
      version,
      phaseDetailThresholdMs,
      ...nodeLogPreambleSections(phaseDetailThresholdMs)
   });
   if (options.logInitialMemory ?? true) {
      shared.Tracer.for('Process').memory('Initial Memory');
   }
   const stopEventLoop = startEventLoopMonitor(shared, options.eventLoop);
   const stopMemory = startMemoryMonitor(shared, options.memory);
   return () => {
      stopEventLoop();
      stopMemory();
   };
}
