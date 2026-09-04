/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format } from '@hydranium/protocol';
import * as os from 'node:os';
import * as v8 from 'node:v8';
import {
   DEFAULT_EVENT_LOOP_INTERVAL_MS,
   DEFAULT_EVENT_LOOP_SNAPSHOT_ABOVE_MS,
   DEFAULT_EVENT_LOOP_THRESHOLD_MS
} from './event-loop-monitor.js';
import { MEMORY_DELTA_BYTES } from '../langium/diagnostics/logger.js';
import { DEFAULT_MEMORY_CRITICAL_THRESHOLD, DEFAULT_MEMORY_WARN_THRESHOLD } from './memory-monitor.js';
import { type LogPreambleOptions } from '../langium/diagnostics/log-preamble.js';

/**
 * Node runtime / host lines for {@link LogPreambleOptions.systemInfoLines}.
 * Pulls `node:os` / `node:v8` / `process` — server-only.
 */
export function nodeSystemInfoLines(): string[] {
   return [
      `node        ${process.version}`,
      `platform    ${process.platform} ${process.arch}`,
      `pid         ${process.pid}`,
      `heap limit  ${Format.bytes(v8.getHeapStatistics().heap_size_limit)}`,
      `host        ${os.hostname()}`
   ];
}

/**
 * Node monitor + memory-suffix convention lines for
 * {@link LogPreambleOptions.conventionLines}. These describe the `[EventLoop]`
 * / `[Memory]` monitors and the heap/rss suffix — all Node-only behaviour, so
 * they're omitted from the portable preamble.
 */
export function nodeConventionLines(phaseDetailThresholdMs = 50): string[] {
   const memoryDeltaMb = MEMORY_DELTA_BYTES / (1024 * 1024);
   const intervalSeconds = DEFAULT_EVENT_LOOP_INTERVAL_MS / 1000;
   const warnPercent = Math.round(DEFAULT_MEMORY_WARN_THRESHOLD * 100);
   const criticalPercent = Math.round(DEFAULT_MEMORY_CRITICAL_THRESHOLD * 100);
   return [
      `• Memory suffix:  heap/rss included on [done] only when heap moved >${memoryDeltaMb}MB since last log,`,
      `                  always included on rebuilds >=${phaseDetailThresholdMs}ms and on [EventLoop] stall warnings`,
      `• [EventLoop]:    warns when a stall >=${DEFAULT_EVENT_LOOP_THRESHOLD_MS}ms is observed within a ${intervalSeconds}s window;`,
      `                  stalls >=${DEFAULT_EVENT_LOOP_SNAPSHOT_ABOVE_MS}ms also trigger a [Process] server-state snapshot`,
      `• [Memory]:       warns >=${warnPercent}% of V8 heap_size_limit, errors >=${criticalPercent}%, info on recovery`
   ];
}

/**
 * Convenience bundle of the Node `logPreamble` sections — spread into
 * the portable `logPreamble`'s options on a Node host:
 * `logPreamble(logger, { productName, version, ...nodeLogPreambleSections() })`.
 */
export function nodeLogPreambleSections(phaseDetailThresholdMs = 50): Pick<LogPreambleOptions, 'systemInfoLines' | 'conventionLines'> {
   return { systemInfoLines: nodeSystemInfoLines(), conventionLines: nodeConventionLines(phaseDetailThresholdMs) };
}
