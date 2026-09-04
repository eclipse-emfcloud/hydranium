/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { formatMemory } from '../langium/diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { formatServerState } from './server-state-snapshot.js';

export const DEFAULT_EVENT_LOOP_THRESHOLD_MS = 100;
export const DEFAULT_EVENT_LOOP_INTERVAL_MS = 1000;
export const DEFAULT_EVENT_LOOP_SNAPSHOT_ABOVE_MS = 500;

export interface EventLoopMonitorOptions {
   /** Stalls >= this within the sample window log a warning. */
   thresholdMs?: number;
   /** Sample window in ms. */
   intervalMs?: number;
   /** Stalls >= this trigger {@link onStallSnapshot} in addition to the warning. */
   snapshotAboveMs?: number;
   /** Log-name label derived from `shared.Logger`. Default `'EventLoop'`. */
   logName?: string;
   /**
    * Fires after a stall >= {@link snapshotAboveMs}; the on-demand command rides
    * the same path. Defaults to a full {@link formatServerState} — process /
    * heap state **plus** per-document detail (`shared.workspace.LangiumDocuments`),
    * logged under the `'Process'` component (matching the on-demand dump). Pass
    * a custom callback to change it, or a no-op to suppress it.
    */
   onStallSnapshot?: (maxMs: number) => void;
}

/**
 * Logs a warning when the event loop is blocked longer than the threshold.
 *
 * Follows the framework `(services, options)` shape: derives its own
 * `'EventLoop'` component logger from `shared.Logger`, and the default
 * stall snapshot reaches `shared.workspace.LangiumDocuments` for per-document
 * detail.
 */
export function startEventLoopMonitor(shared: ServerSharedServicesMinimal, options: EventLoopMonitorOptions = {}): () => void {
   const logger = shared.Logger.for(options.logName ?? 'EventLoop');
   const thresholdMs = options.thresholdMs ?? DEFAULT_EVENT_LOOP_THRESHOLD_MS;
   const intervalMs = options.intervalMs ?? DEFAULT_EVENT_LOOP_INTERVAL_MS;
   const snapshotAboveMs = options.snapshotAboveMs ?? DEFAULT_EVENT_LOOP_SNAPSHOT_ABOVE_MS;
   const onStallSnapshot =
      options.onStallSnapshot ??
      ((maxMs: number) =>
         shared.Logger.for('Process').info(
            formatServerState(shared.workspace.LangiumDocuments, `auto: event-loop stall ${Math.round(maxMs)}ms`)
         ));
   const histogram = monitorEventLoopDelay({ resolution: 10 });
   histogram.enable();
   const interval = setInterval(() => {
      const maxMs = histogram.max / 1e6;
      if (maxMs >= thresholdMs) {
         const p99Ms = histogram.percentile(99) / 1e6;
         const meanMs = histogram.mean / 1e6;
         // Always include heap/rss: stalls are the moment to correlate with memory pressure.
         logger.warn(
            `Event-loop stall up to ${Math.round(maxMs)}ms ` +
               `in last ${intervalMs}ms ` +
               `(p99 ${Math.round(p99Ms)}ms, ` +
               `mean ${meanMs.toFixed(1)}ms, ` +
               `${formatMemory()})`
         );
         if (maxMs >= snapshotAboveMs) {
            // Defensive: a snapshot failure must not silence subsequent stall warnings.
            try {
               onStallSnapshot(maxMs);
            } catch (error) {
               logger.warn(`Stall snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
            }
         }
      }
      histogram.reset();
   }, intervalMs);
   // Do not keep the process alive solely for the monitor.
   interval.unref?.();
   return () => {
      clearInterval(interval);
      histogram.disable();
   };
}
