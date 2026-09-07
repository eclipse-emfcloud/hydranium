/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger, type LogThreshold } from '@hydranium/protocol';
import * as v8 from 'node:v8';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { startMemoryMonitor } from '../../src/node/memory-monitor.js';
import { makeCapturingLogger, makeNoopSharedServices } from '../../src/testing/index.js';

// v8.getHeapStatistics is an ESM export and cannot be spied, so drive the ratio
// through process.memoryUsage against the REAL heap-size limit instead of faking it.
const HEAP_LIMIT = v8.getHeapStatistics().heap_size_limit;

/** A memoryUsage reading whose heapUsed yields the given usage ratio against the real limit. */
function memoryAtRatio(ratio: number): NodeJS.MemoryUsage {
   const heapUsed = Math.ceil(ratio * HEAP_LIMIT);
   return { rss: heapUsed, heapTotal: HEAP_LIMIT, heapUsed, external: 0, arrayBuffers: 0 };
}

describe('startMemoryMonitor', () => {
   let memorySpy: MockInstance<typeof process.memoryUsage>;
   let priorLevel: LogThreshold;

   beforeEach(() => {
      priorLevel = Logger.getLevel();
      Logger.setLevel('trace'); // capture info/warn/error through the process-wide threshold
      vi.useFakeTimers();
      memorySpy = vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryAtRatio(0.5));
   });
   afterEach(() => {
      vi.useRealTimers();
      memorySpy.mockRestore();
      Logger.setLevel(priorLevel);
   });

   it('stays silent while heap usage is below the warn threshold', () => {
      const { logger, lines } = makeCapturingLogger();
      const stop = startMemoryMonitor(makeNoopSharedServices({ Logger: logger }), { intervalMs: 1000, cooldownMs: 5000 });
      memorySpy.mockReturnValue(memoryAtRatio(0.5));
      vi.advanceTimersByTime(3000); // three samples
      expect(lines).toEqual([]);
      stop();
   });

   it('warns on entering the warn band, escalates to error at critical, and recovers with info', () => {
      const { logger, lines } = makeCapturingLogger();
      const stop = startMemoryMonitor(makeNoopSharedServices({ Logger: logger }), { intervalMs: 1000, cooldownMs: 5000 });
      memorySpy.mockReturnValue(memoryAtRatio(0.9)); // warn
      vi.advanceTimersByTime(1000);
      memorySpy.mockReturnValue(memoryAtRatio(0.96)); // critical
      vi.advanceTimersByTime(1000);
      memorySpy.mockReturnValue(memoryAtRatio(0.5)); // recovered
      vi.advanceTimersByTime(1000);
      expect(lines.map(line => line.level)).toEqual(['warn', 'error', 'info']);
      expect(lines[1].message).toContain('imminent out-of-memory');
      expect(lines[2].message).toContain('recovered');
      stop();
   });

   it('rate-limits repeated same-severity warnings by the cooldown, re-emitting after it elapses', () => {
      const { logger, lines } = makeCapturingLogger();
      const stop = startMemoryMonitor(makeNoopSharedServices({ Logger: logger }), { intervalMs: 1000, cooldownMs: 5000 });
      memorySpy.mockReturnValue(memoryAtRatio(0.9)); // stays in the warn band throughout
      vi.advanceTimersByTime(1000); // t=1000: ok -> warn transition, emits
      vi.advanceTimersByTime(3000); // t=4000: still warn, within cooldown of the t=1000 emit -> suppressed
      expect(lines).toHaveLength(1);
      vi.advanceTimersByTime(3000); // t=7000: >= 5000ms since the last emit -> re-emits
      expect(lines).toHaveLength(2);
      expect(lines.every(line => line.level === 'warn')).toBe(true);
      stop();
   });

   it('stops sampling once the returned disposer runs', () => {
      const { logger, lines } = makeCapturingLogger();
      const stop = startMemoryMonitor(makeNoopSharedServices({ Logger: logger }), { intervalMs: 1000 });
      stop();
      memorySpy.mockReturnValue(memoryAtRatio(0.96)); // critical — but the interval is cleared
      vi.advanceTimersByTime(5000);
      expect(lines).toEqual([]);
   });
});
