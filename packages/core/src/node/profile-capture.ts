/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Node-only sampled-profile capture: CPU + allocation over a window (one
 * `node:inspector` session), plus GC and event-loop delay from
 * `node:perf_hooks`, and an optional retained heap snapshot. Everything is
 * default-off and singleton-guarded — the write returns one large JSON object
 * and briefly blocks the event loop, so nothing here is ever auto-triggered.
 * The mechanical, process-level counterpart to the protocol's in-code
 * `ProfileSession` (aggregate self-time spans).
 */

import { Format, type ProfileCaptureOptions } from '@hydranium/protocol';
import * as fs from 'node:fs';
import { Session } from 'node:inspector';
import {
   constants,
   monitorEventLoopDelay,
   PerformanceObserver,
   performance,
   type IntervalHistogram,
   type PerformanceEntry
} from 'node:perf_hooks';
import { snapshotFilePath, writeHeapSnapshotToDir } from './process-memory.js';

export const DEFAULT_CPU_INTERVAL_MICROS = 1000;
export const DEFAULT_ALLOCATION_INTERVAL_BYTES = 32768;

// The capture-request shape is neutral and lives in `@hydranium/protocol` (it
// crosses the wire as the data-server `startProfiling` args); re-export it here
// so `@hydranium/core/node` consumers keep a single import site for the capture.
export type { ProfileCaptureOptions };

/** V8 GC-kind flag → readable name; unknown flags fall back to the number as a string. */
const GC_KIND_NAMES: Record<number, string> = {
   [constants.NODE_PERFORMANCE_GC_MINOR]: 'scavenge',
   [constants.NODE_PERFORMANCE_GC_MAJOR]: 'mark-sweep-compact',
   [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental-marking',
   [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak-callbacks'
};

/** One GC pause: the numeric V8 kind flag and its duration in ms. */
export interface GcEntry {
   kind: number;
   durationMs: number;
}

/** The `count`/`mean`/`max`/`percentile` surface of a `node:perf_hooks` event-loop-delay histogram (ns). */
export interface EventLoopDelayHistogram {
   readonly count: number;
   readonly mean: number;
   readonly max: number;
   percentile(percent: number): number;
}

/** The captured artefacts + a compact summary. Profile files are written to the session directory. */
export interface ProfileReport {
   durationMs: number;
   cpuProfilePath?: string;
   allocationProfilePath?: string;
   heapSnapshotPath?: string;
   gc?: { count: number; totalPauseMs: number; byKind: Record<string, { count: number; pauseMs: number }> };
   eventLoopDelay?: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
   cpuUsage: { userMs: number; systemMs: number };
   memoryDelta: { rssBytes: number; heapUsedBytes: number };
}

/**
 * Tally GC pauses by kind, mapping V8's numeric kind flag to a readable name.
 * Pure — the timing-dependent capture feeds it the entries.
 */
export function summarizeGc(entries: readonly GcEntry[]): NonNullable<ProfileReport['gc']> {
   const byKind: Record<string, { count: number; pauseMs: number }> = {};
   let totalPauseMs = 0;
   for (const { kind, durationMs } of entries) {
      const name = GC_KIND_NAMES[kind] ?? String(kind);
      const bucket = (byKind[name] ??= { count: 0, pauseMs: 0 });
      bucket.count += 1;
      bucket.pauseMs += durationMs;
      totalPauseMs += durationMs;
   }
   return { count: entries.length, totalPauseMs, byKind };
}

/**
 * Convert an event-loop-delay histogram (nanoseconds) to a millisecond summary,
 * or `undefined` when the histogram recorded nothing (a purely synchronous
 * window never lets the sampler tick, leaving `mean === NaN`). Pure.
 */
export function summarizeEventLoopDelay(histogram: EventLoopDelayHistogram): NonNullable<ProfileReport['eventLoopDelay']> | undefined {
   if (histogram.count === 0 || !Number.isFinite(histogram.mean)) {
      return undefined;
   }
   const toMs = (nanos: number): number => nanos / 1e6;
   return {
      meanMs: toMs(histogram.mean),
      p50Ms: toMs(histogram.percentile(50)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max)
   };
}

/** A byte delta with an explicit sign (`Format.bytes` alone drops the sign of a shrink). */
function signedBytes(bytes: number): string {
   return `${bytes < 0 ? '-' : '+'}${Format.bytes(Math.abs(bytes))}`;
}

/**
 * Render a {@link ProfileReport} as a compact multi-line block for a log line or a
 * command channel — the sampled-profile counterpart to `formatProcessMemory`.
 * Absent dimensions (no gc/eld capture, no written artefacts) are simply omitted.
 */
export function formatProfileReport(report: ProfileReport, label = 'Profile report'): string {
   const lines = [
      `${label}:`,
      `  duration    ${Format.elapsed(report.durationMs)}`,
      `  cpu usage   user ${Math.round(report.cpuUsage.userMs)}ms / system ${Math.round(report.cpuUsage.systemMs)}ms`,
      `  memory Δ    rss ${signedBytes(report.memoryDelta.rssBytes)}, heapUsed ${signedBytes(report.memoryDelta.heapUsedBytes)}`
   ];
   if (report.gc) {
      const byKind = Object.entries(report.gc.byKind).map(([name, { count, pauseMs }]) => `${name} ×${count} ${Math.round(pauseMs)}ms`);
      const detail = byKind.length > 0 ? ` — ${byKind.join(', ')}` : '';
      lines.push(`  gc          ${report.gc.count} pauses, ${Math.round(report.gc.totalPauseMs)}ms total${detail}`);
   }
   if (report.eventLoopDelay) {
      const { meanMs, p50Ms, p99Ms, maxMs } = report.eventLoopDelay;
      lines.push(
         `  event loop  mean ${meanMs.toFixed(1)}ms / p50 ${p50Ms.toFixed(1)}ms / p99 ${p99Ms.toFixed(1)}ms / max ${maxMs.toFixed(1)}ms`
      );
   }
   if (report.cpuProfilePath) {
      lines.push(`  cpu profile ${report.cpuProfilePath}`);
   }
   if (report.allocationProfilePath) {
      lines.push(`  alloc prof  ${report.allocationProfilePath}`);
   }
   if (report.heapSnapshotPath) {
      lines.push(`  heap snap   ${report.heapSnapshotPath}`);
   }
   return lines.join('\n');
}

/** Minimal structural view of a `node:inspector` `Session` — its typed per-method overloads can't be called generically. */
interface InspectorSessionLike {
   connect(): void;
   disconnect(): void;
   post(method: string, params: Record<string, unknown>, callback: (error: Error | null, result?: unknown) => void): void;
}

function post(session: InspectorSessionLike, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
   return new Promise((resolve, reject) => {
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
   });
}

function toGcEntry(entry: PerformanceEntry): GcEntry {
   // `detail` carries the GC kind at runtime but is absent from this @types/node's PerformanceEntry.
   const detail = (entry as PerformanceEntry & { detail?: { kind?: number } | null }).detail;
   return { kind: detail?.kind ?? 0, durationMs: entry.duration };
}

/** The one active capture, if any — a single inspector session per process. */
let active: ProfileCapture | undefined;

/**
 * A windowed, sampled profile of the current process. Start it, run the workload,
 * stop it to get artefact paths + a summary. Singleton-guarded (one inspector
 * session at a time); prefer {@link profileWorkload} for the common wrap-a-block case.
 */
export class ProfileCapture {
   protected startedAt = 0;
   protected startCpu: NodeJS.CpuUsage = { user: 0, system: 0 };
   protected startMem: NodeJS.MemoryUsage = process.memoryUsage();
   protected session?: InspectorSessionLike;
   protected histogram?: IntervalHistogram;
   protected gcObserver?: PerformanceObserver;
   protected gcEntries: GcEntry[] = [];

   protected constructor(protected readonly options: ProfileCaptureOptions) {}

   static isActive(): boolean {
      return active !== undefined;
   }

   static async start(options: ProfileCaptureOptions): Promise<ProfileCapture> {
      if (active) {
         throw new Error('A ProfileCapture is already active; stop it before starting another.');
      }
      const capture = new ProfileCapture(options);
      active = capture;
      try {
         await capture.begin();
      } catch (error) {
         // begin() may have connected the inspector session / started a sampler
         // before throwing; tear it all down (and clear the singleton) so a failed
         // start neither leaks a live session nor lets the next start build a second.
         capture.teardown();
         throw error;
      }
      return capture;
   }

   protected async begin(): Promise<void> {
      this.startedAt = performance.now();
      this.startCpu = process.cpuUsage();
      this.startMem = process.memoryUsage();
      if (this.options.cpu || this.options.allocation) {
         const session = new Session() as unknown as InspectorSessionLike;
         session.connect();
         this.session = session;
         if (this.options.cpu) {
            await post(session, 'Profiler.enable');
            await post(session, 'Profiler.setSamplingInterval', {
               interval: this.options.cpuIntervalMicros ?? DEFAULT_CPU_INTERVAL_MICROS
            });
            await post(session, 'Profiler.start');
         }
         if (this.options.allocation) {
            await post(session, 'HeapProfiler.enable');
            await post(session, 'HeapProfiler.startSampling', {
               samplingInterval: this.options.allocationIntervalBytes ?? DEFAULT_ALLOCATION_INTERVAL_BYTES
            });
         }
      }
      if (this.options.gc) {
         this.gcEntries = [];
         this.gcObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
               this.gcEntries.push(toGcEntry(entry));
            }
         });
         this.gcObserver.observe({ entryTypes: ['gc'] });
      }
      if (this.options.eventLoopDelay) {
         this.histogram = monitorEventLoopDelay({ resolution: 10 });
         this.histogram.enable();
      }
   }

   async stop(directory: string | undefined, label: string): Promise<ProfileReport> {
      if (active !== this) {
         throw new Error('ProfileCapture.stop called on an inactive capture.');
      }
      const durationMs = performance.now() - this.startedAt;
      // Sample cpu + memory at the workload boundary (alongside durationMs), NOT
      // after teardown: the synchronous profile write inflates RSS and the heap
      // snapshot forces a full GC, so a post-teardown read would fold the
      // profiler's own cost into the deltas meant to frame the profiled window.
      const cpu = process.cpuUsage(this.startCpu);
      const mem = process.memoryUsage();
      // Everything below can throw — a `post` can reject on a dropped session, and
      // the synchronous profile write can fail on ENOSPC/EACCES. Release the
      // inspector session, the perf_hooks observers and the singleton in `finally`
      // regardless, so a failed stop() never leaks a live sampler or wedges the
      // process-wide `active` guard against every future capture.
      try {
         // Create the target directory up front so the profile files land there
         // rather than scattering to os.tmpdir() via snapshotFilePath's fallback,
         // and so a caller writing a summary beside them finds the directory.
         if (directory) {
            fs.mkdirSync(directory, { recursive: true });
         }
         // Stop BOTH inspector samplers before serializing anything: writing the CPU
         // profile allocates, and a still-running allocation sampler would record that
         // write as if it were the profiled program's work.
         let cpuProfile: unknown;
         if (this.options.cpu && this.session) {
            cpuProfile = ((await post(this.session, 'Profiler.stop')) as { profile: unknown }).profile;
            await post(this.session, 'Profiler.disable');
         }
         let allocationProfile: unknown;
         if (this.options.allocation && this.session) {
            allocationProfile = ((await post(this.session, 'HeapProfiler.stopSampling')) as { profile: unknown }).profile;
            await post(this.session, 'HeapProfiler.disable');
         }
         // GC + event-loop delay come from perf_hooks, independent of the samplers.
         let gc: ProfileReport['gc'];
         if (this.gcObserver) {
            await new Promise<void>(resolve => setImmediate(resolve));
            for (const entry of this.gcObserver.takeRecords()) {
               this.gcEntries.push(toGcEntry(entry));
            }
            gc = summarizeGc(this.gcEntries);
         }
         let eventLoopDelay: ProfileReport['eventLoopDelay'];
         if (this.histogram) {
            eventLoopDelay = summarizeEventLoopDelay(this.histogram);
         }
         // Serialize now that no sampler is running.
         const cpuProfilePath =
            cpuProfile !== undefined ? this.writeProfileFile(cpuProfile, directory, label, 'server-cpu', 'cpuprofile') : undefined;
         const allocationProfilePath =
            allocationProfile !== undefined
               ? this.writeProfileFile(allocationProfile, directory, label, 'server-alloc', 'heapprofile')
               : undefined;
         const heapSnapshotPath = this.options.heapSnapshot ? writeHeapSnapshotToDir(directory, label) : undefined;
         return {
            durationMs,
            cpuProfilePath,
            allocationProfilePath,
            heapSnapshotPath,
            gc,
            eventLoopDelay,
            cpuUsage: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
            memoryDelta: { rssBytes: mem.rss - this.startMem.rss, heapUsedBytes: mem.heapUsed - this.startMem.heapUsed }
         };
      } finally {
         this.teardown();
      }
   }

   /**
    * Release the inspector session, perf_hooks observers and the process-wide
    * singleton. Each disposal is best-effort so one failure cannot skip the rest
    * (or mask the error that triggered teardown), and nulling the handles makes a
    * repeat teardown a no-op.
    */
   protected teardown(): void {
      try {
         this.gcObserver?.disconnect();
      } catch {
         // best effort — the observer may already be gone
      }
      try {
         this.histogram?.disable();
      } catch {
         // best effort
      }
      try {
         this.session?.disconnect();
      } catch {
         // best effort — the session may already be disconnected
      }
      this.gcObserver = undefined;
      this.histogram = undefined;
      this.session = undefined;
      active = undefined;
   }

   protected writeProfileFile(profile: unknown, directory: string | undefined, label: string, prefix: string, ext: string): string {
      const filePath = snapshotFilePath(directory, label, prefix, ext);
      // Synchronous stringify+write of a large object briefly blocks the loop and
      // inflates RSS — acceptable because capture is opt-in and never auto-run.
      fs.writeFileSync(filePath, JSON.stringify(profile));
      return filePath;
   }
}

/**
 * Capture a subset of dimensions around an arbitrary async block — the harness /
 * bench / CLI entry. Always releases the singleton session, even if {@link run}
 * throws (the error propagates). Writes profile files to `options.directory`.
 */
export async function profileWorkload<T>(
   options: ProfileCaptureOptions & { directory?: string; label?: string },
   run: () => Promise<T>
): Promise<{ result: T; report: ProfileReport }> {
   const capture = await ProfileCapture.start(options);
   const label = options.label ?? 'workload';
   try {
      const result = await run();
      const report = await capture.stop(options.directory, label);
      return { result, report };
   } catch (error) {
      if (ProfileCapture.isActive()) {
         await capture.stop(options.directory, label).catch(() => undefined);
      }
      throw error;
   }
}
