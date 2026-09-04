/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Per-operation latency/throughput accumulator — the time/throughput axis of a
 * profiling run (the CPU profile says "where time went in aggregate"; this says
 * "method X ran N times at p99 Y ms"). It sits on the framework's timing
 * primitives (`Clock`), not on a Node inspector session, so it is neutral and
 * lives here in `protocol`: the RPC binder feeds it at one chokepoint and the
 * LSP connection decorator feeds it at another, both cross-head. A running head
 * holds one collector and reads `report()` out (e.g. over the diagnostics wire
 * or into a bundle's `server-latency.json`).
 */

import { type Clock, type Stopwatch, SystemClock } from './clock.js';

/** Latency/throughput for one method over the collection window. */
export interface MethodLatency {
   /**
    * Whatever key the caller passed to {@link LatencyCollector.record} or
    * {@link LatencyCollector.time} — the framework feeds it RPC and LSP method
    * names, but nothing enforces that, so two feeds using different spellings
    * for one operation report as two methods.
    */
   method: string;
   /**
    * Calls since construction or the last {@link LatencyCollector.reset}, which
    * is the only thing that clears it. Unaffected by retention: a ring-buffer
    * collector keeps counting long after it stops keeping samples. Failed calls
    * are counted — a call that threw still consumed time.
    */
   count: number;
   /**
    * Milliseconds, nearest-rank over the RETAINED samples rather than over
    * {@link count} calls, so under `ring-buffer` retention it describes only the
    * trailing window and can sit well below {@link maxMs}. `0` means no samples
    * were retained, not that calls were instant.
    */
   p50Ms: number;
   /** Milliseconds, nearest-rank; same retention caveat as {@link p50Ms}. */
   p99Ms: number;
   /**
    * Milliseconds, the slowest single call since the last reset. A lifetime
    * figure, so a spike that has aged out of a ring buffer still shows here
    * after the percentiles have forgotten it.
    */
   maxMs: number;
   /**
    * Milliseconds summed across every call since the last reset, retention
    * notwithstanding. This is what {@link LatencyCollector.report} ranks on, so
    * it orders by total cost rather than by per-call slowness.
    */
   totalMs: number;
}

/** A collector snapshot: the window length and the per-method latencies, hottest first. */
export interface LatencyReport {
   /**
    * Milliseconds elapsed since construction or the last
    * {@link LatencyCollector.reset}, off the monotonic stopwatch. It bounds the
    * throughput a caller can derive; it is not the sum of the method totals,
    * which overlap and can exceed it under concurrency.
    */
   windowMs: number;
   /**
    * Ordered by {@link MethodLatency.totalMs} descending. A method that was
    * never called is absent rather than present with zeroes, so an empty array
    * means nothing ran in the window.
    */
   methods: MethodLatency[];
}

/**
 * How many samples a collector retains for percentile estimation. `keep-all`
 * (the default) stores every duration for exact nearest-rank percentiles — sized
 * for a bounded diagnostics window that gets read then {@link LatencyCollector.reset}.
 * `ring-buffer` caps retention at `maxSamplesPerMethod`, keeping only the most
 * recent samples so a collector left running indefinitely cannot grow without
 * bound; percentiles then cover that trailing window while `count`/`totalMs`/
 * `maxMs` remain lifetime totals.
 */
export type LatencyRetention = { readonly kind: 'keep-all' } | { readonly kind: 'ring-buffer'; readonly maxSamplesPerMethod: number };

/** Per-method state: retained samples (bounded in ring-buffer mode) plus lifetime totals. */
interface MethodAccumulator {
   /** Retained durations for percentile estimation; capped in ring-buffer mode. Order is irrelevant (report sorts). */
   readonly samples: number[];
   /** Next slot to overwrite once the ring buffer is full (ring-buffer mode only). */
   writeIndex: number;
   /** Lifetime call count, unaffected by retention. */
   count: number;
   /** Lifetime total duration, unaffected by retention. */
   totalMs: number;
   /** Lifetime maximum duration, so a spike that ages out of the window still shows. */
   maxMs: number;
}

/** Nearest-rank percentile of an ascending-sorted array (empty → 0). */
function percentile(sortedAscending: readonly number[], percent: number): number {
   if (sortedAscending.length === 0) {
      return 0;
   }
   const rank = Math.ceil((percent / 100) * sortedAscending.length);
   return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

/**
 * Accumulates per-method call durations and reports count + latency percentiles.
 * Exact (keeps every duration per method) — sized for a diagnostics window, not
 * unbounded production telemetry; {@link reset} drops the samples and restarts
 * the window. Feed it via {@link time} (wraps a call) or {@link record} (a
 * pre-measured duration). Timing rides an injectable {@link Clock} so tests are
 * deterministic on a fake clock.
 */
export class LatencyCollector {
   protected readonly durations = new Map<string, MethodAccumulator>();
   protected window: Stopwatch;

   constructor(
      protected readonly clock: Clock = new SystemClock(),
      protected readonly retention: LatencyRetention = { kind: 'keep-all' }
   ) {
      if (retention.kind === 'ring-buffer' && retention.maxSamplesPerMethod < 1) {
         throw new RangeError(`ring-buffer maxSamplesPerMethod must be >= 1, got ${retention.maxSamplesPerMethod}`);
      }
      this.window = this.clock.stopwatch();
   }

   /** Record a pre-measured call duration (ms) for `method`. */
   record(method: string, durationMs: number): void {
      let accumulator = this.durations.get(method);
      if (!accumulator) {
         accumulator = { samples: [], writeIndex: 0, count: 0, totalMs: 0, maxMs: 0 };
         this.durations.set(method, accumulator);
      }
      accumulator.count++;
      accumulator.totalMs += durationMs;
      if (durationMs > accumulator.maxMs) {
         accumulator.maxMs = durationMs;
      }
      if (this.retention.kind === 'ring-buffer' && accumulator.samples.length >= this.retention.maxSamplesPerMethod) {
         // Buffer full: overwrite the oldest slot in O(1) (percentiles sort, so order does not matter).
         accumulator.samples[accumulator.writeIndex] = durationMs;
         accumulator.writeIndex = (accumulator.writeIndex + 1) % this.retention.maxSamplesPerMethod;
      } else {
         accumulator.samples.push(durationMs);
      }
   }

   /**
    * Run `call`, record how long it took under `method`, and return its result.
    * The duration is recorded even when the call throws/rejects (a failed call
    * still consumed time), then the error propagates.
    */
   time<T>(method: string, call: () => Promise<T>): Promise<T>;
   time<T>(method: string, call: () => T): T;
   time<T>(method: string, call: () => T | Promise<T>): T | Promise<T> {
      const stopwatch = this.clock.stopwatch();
      const finish = (): void => this.record(method, stopwatch.elapsedMs);
      let result: T | Promise<T>;
      try {
         result = call();
      } catch (error) {
         finish();
         throw error;
      }
      if (result instanceof Promise) {
         return result.then(
            value => {
               finish();
               return value;
            },
            error => {
               finish();
               throw error;
            }
         );
      }
      finish();
      return result;
   }

   /** Non-destructive snapshot: per-method latencies ordered by total time descending (use {@link reset} to drain). */
   report(): LatencyReport {
      const methods: MethodLatency[] = [];
      for (const [method, accumulator] of this.durations) {
         const sorted = [...accumulator.samples].sort((left, right) => left - right);
         methods.push({
            method,
            count: accumulator.count,
            totalMs: accumulator.totalMs,
            maxMs: accumulator.maxMs,
            p50Ms: percentile(sorted, 50),
            p99Ms: percentile(sorted, 99)
         });
      }
      methods.sort((left, right) => right.totalMs - left.totalMs);
      return { windowMs: this.window.elapsedMs, methods };
   }

   /** Drop all samples and restart the window. */
   reset(): void {
      this.durations.clear();
      this.window = this.clock.stopwatch();
   }
}

/**
 * Render a {@link LatencyReport} as a compact ranked table for a log line or a
 * command channel — the latency counterpart to `formatProfileReport`.
 */
export function formatLatencyReport(report: LatencyReport, label = 'RPC/LSP latency'): string {
   const lines = [`${label} (window ${Math.round(report.windowMs)}ms):`];
   if (report.methods.length === 0) {
      lines.push('  (no calls recorded)');
      return lines.join('\n');
   }
   for (const methodLatency of report.methods) {
      lines.push(
         `  ${methodLatency.method}  n=${methodLatency.count}  total ${Math.round(methodLatency.totalMs)}ms  ` +
            `p50 ${Math.round(methodLatency.p50Ms)}ms  p99 ${Math.round(methodLatency.p99Ms)}ms  max ${Math.round(methodLatency.maxMs)}ms`
      );
   }
   return lines.join('\n');
}
