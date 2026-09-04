/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, DefaultTracer, type Logger, type LogLevel, type TimeOptions } from '@hydranium/protocol';
import { isOperationCancelled } from '@hydranium/langium';
import { currentMemoryUsage } from '../../util/environment.js';
import { formatMemory, MEMORY_DELTA_BYTES } from './logger.js';

/** Last heapUsed at which a memory readout / suffix was logged. Gates the delta suffix. */
let lastLoggedHeapBytes = 0;

/**
 * Server-side {@link DefaultTracer}. Adds the Node-specific observability the
 * generic tracer leaves to subclasses:
 *  - {@link memory} renders the full `heap used/total, rss N` line via
 *    `process.memoryUsage()` (richer than the generic used/total reader);
 *  - {@link timingSuffix} appends a memory-delta suffix to `[done]` lines when
 *    the heap has moved significantly (or `forceMemoryAboveMs` overrides);
 *  - {@link categorizeError} maps `OperationCancelled` to `cancelled` so
 *    routine build cancellations stay quiet instead of logging as failures.
 */
export class ServerTracer extends DefaultTracer {
   constructor(logger: Logger, clock: Clock) {
      super(logger, clock);
   }

   override memory(label?: string, logLevel: LogLevel = 'info'): void {
      const mem = currentMemoryUsage();
      if (!mem) {
         // No process memory stats (browser) — a contentless "Memory:" line is just noise.
         return;
      }
      lastLoggedHeapBytes = mem.heapUsed;
      const prefix = label ? `${label}: ` : 'Memory: ';
      this.logger[logLevel](`${prefix}${formatMemory()}`);
   }

   protected override derive(logger: Logger): this {
      return new ServerTracer(logger, this.clock) as this;
   }

   protected override timingSuffix(status: 'done' | 'failed' | 'cancelled', elapsedMs: number, options: TimeOptions): string {
      if (status === 'cancelled') {
         return '';
      }
      const force = options.forceMemoryAboveMs !== undefined && elapsedMs >= options.forceMemoryAboveMs;
      return formatMemoryDelta(force);
   }

   protected override categorizeError(error: unknown): 'failed' | 'cancelled' {
      return isOperationCancelled(error) ? 'cancelled' : 'failed';
   }
}

/** Memory suffix, only when heap moved significantly — unless `force` overrides the gate. */
function formatMemoryDelta(force = false): string {
   const mem = currentMemoryUsage();
   if (!mem) {
      return '';
   }
   const heap = mem.heapUsed;
   if (!force && Math.abs(heap - lastLoggedHeapBytes) < MEMORY_DELTA_BYTES) {
      return '';
   }
   lastLoggedHeapBytes = heap;
   return `, ${formatMemory()}`;
}
