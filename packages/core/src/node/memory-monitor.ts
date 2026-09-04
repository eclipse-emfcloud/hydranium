/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format } from '@hydranium/protocol';
import * as v8 from 'node:v8';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';

/** Heap usage ratio (heapUsed / heap_size_limit) above which we emit a warning. */
export const DEFAULT_MEMORY_WARN_THRESHOLD = 0.85;
/** Heap usage ratio above which we emit an error-level warning (imminent OOM likely). */
export const DEFAULT_MEMORY_CRITICAL_THRESHOLD = 0.95;
/** Cooldown between repeated warnings at the same level, in ms. */
export const DEFAULT_COOLDOWN_MS = 30_000;
/** Default heap-sampling interval, in ms. */
export const DEFAULT_MEMORY_INTERVAL_MS = 5_000;

type Severity = 'ok' | 'warn' | 'critical';

export interface MemoryMonitorOptions {
   /** Heap-usage ratio (0..1) above which a warning is emitted. Default {@link DEFAULT_MEMORY_WARN_THRESHOLD}. */
   warnThreshold?: number;
   /** Heap-usage ratio above which an error is emitted (imminent OOM likely). Default {@link DEFAULT_MEMORY_CRITICAL_THRESHOLD}. */
   criticalThreshold?: number;
   /** Sample interval, in ms. Default {@link DEFAULT_MEMORY_INTERVAL_MS}. */
   intervalMs?: number;
   /** Cooldown between repeats at the same severity, in ms. Default {@link DEFAULT_COOLDOWN_MS}. */
   cooldownMs?: number;
   /** Log-name label derived from `shared.Logger`. Default `'Memory'`. */
   logName?: string;
}

/**
 * Monitors V8 heap usage and emits a warning when the heap approaches its configured limit.
 *
 * Rate-limits repeated warnings at the same severity by `cooldownMs`, and always re-emits
 * on a transition (ok→warn, warn→critical, or back down). Uses `v8.getHeapStatistics().heap_size_limit`
 * which respects Node's `--max-old-space-size` flag. Warnings give you a chance to correlate slowdowns,
 * GC pressure, or imminent OOM failures with a specific operation in the accompanying timing logs.
 *
 * Follows the framework `(services, options)` shape: derives its own `'Memory'`
 * component logger from `shared.Logger`.
 */
export function startMemoryMonitor(shared: ServerSharedServicesMinimal, options: MemoryMonitorOptions = {}): () => void {
   const logger = shared.Logger.for(options.logName ?? 'Memory');
   const warnThreshold = options.warnThreshold ?? DEFAULT_MEMORY_WARN_THRESHOLD;
   const criticalThreshold = options.criticalThreshold ?? DEFAULT_MEMORY_CRITICAL_THRESHOLD;
   const intervalMs = options.intervalMs ?? DEFAULT_MEMORY_INTERVAL_MS;
   const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
   let lastSeverity: Severity = 'ok';
   let lastEmittedAt = 0;

   const severityFor = (ratio: number): Severity => {
      if (ratio >= criticalThreshold) {
         return 'critical';
      }
      if (ratio >= warnThreshold) {
         return 'warn';
      }
      return 'ok';
   };

   const check = (): void => {
      const mem = process.memoryUsage();
      const heapLimit = v8.getHeapStatistics().heap_size_limit;
      const ratio = mem.heapUsed / heapLimit;
      const severity = severityFor(ratio);
      if (severity === 'ok' && lastSeverity === 'ok') {
         return;
      }
      const now = Date.now();
      const shouldEmit = severity !== lastSeverity || now - lastEmittedAt >= cooldownMs;
      if (!shouldEmit) {
         return;
      }
      const percent = Math.round(ratio * 100);
      const message =
         `Heap usage ${percent}% (${Format.bytes(mem.heapUsed)} / ${Format.bytes(heapLimit)} limit), rss ${Format.bytes(mem.rss)}` +
         (severity === 'critical'
            ? ' - imminent out-of-memory possible, server may crash'
            : severity === 'warn'
              ? ' - garbage collection pressure may slow operations'
              : ' - recovered below warning threshold');
      if (severity === 'critical') {
         logger.error(message);
      } else if (severity === 'warn') {
         logger.warn(message);
      } else {
         logger.info(message);
      }
      lastSeverity = severity;
      lastEmittedAt = now;
   };

   const interval = setInterval(check, intervalMs);
   interval.unref?.();
   return () => clearInterval(interval);
}
