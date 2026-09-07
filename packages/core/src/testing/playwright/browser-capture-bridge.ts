/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * The Playwright-side bridge for the browser axis of a profiling run. The
 * renderer-runtime read mirrors `@hydranium/client-theia`'s `captureBrowserRuntime`;
 * the main-thread timeline is bridge-only (there is no live-capture counterpart).
 * Both run IN the renderer; only the Playwright process has both page access and fs
 * access, so it is the natural place to pull them out and write them beside the
 * server-side artefacts.
 *
 * A `page.evaluate` function is serialised to source and re-run in the page — it
 * CANNOT reference this module's imports or the client-theia bundle, so the
 * capture is reimplemented inline here (self-contained), which also means the
 * bridge needs ZERO app-side wiring: it works against any Theia/browser page. The
 * page-side browser globals (`performance`, `PerformanceObserver`) are reached
 * through local structural types cast from `globalThis`, so this node-side module
 * needs no DOM lib and keeps no dependency on the browser package.
 *
 * The report shapes are the shared `@hydranium/protocol` ones: `BrowserRuntimeReport`
 * — the same type the client-theia live capture emits, so there is a single
 * `browser-runtime.json` shape — plus `BrowserStateReport` / `BrowserTimelineEntry`,
 * whose timeline half only this bridge produces.
 */

import type { BrowserRuntimeReport, BrowserRuntimeSample, BrowserStateReport, BrowserTimelineEntry } from '@hydranium/protocol';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural subset of a Playwright `Page` used by the bridge — declared locally
 * so this module imports nothing from `@playwright/test` (an optional peer). The
 * single-argument `evaluate` matches Playwright's `page.evaluate(pageFunction)`.
 */
export interface EvaluatablePage {
   evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
}

/**
 * Structural subset of a Playwright `CDPSession` — `send(method, params?)` plus the
 * EventEmitter `on`/`off` for streamed responses. Declared locally so this module
 * keeps its zero-dependency-on-`@playwright/test` discipline; the adopter obtains
 * the real session with `page.context().newCDPSession(page)` and passes it in.
 *
 * CDP is a driver-side protocol — a session can only be opened by the process
 * DRIVING the browser (Playwright), never by page JS on itself. That is why the
 * CDP-backed captures ({@link captureBrowserRuntimeSample}, {@link captureBrowserHeapSnapshot})
 * are e2e-only, whereas the page-side `page.evaluate` read this bridge also performs
 * has a live counterpart in the frontend's "Dump Frontend State" command. The
 * CDP captures also need no cross-origin isolation.
 *
 * `send`/`on`/`off` are declared as METHODS (not arrow-typed properties) on purpose:
 * TypeScript checks method parameters bivariantly, so Playwright's `CDPSession` —
 * whose `send` is typed per-method — is assignable to this neutral type with NO cast
 * (`const cdp: CdpSession = await page.context().newCDPSession(page)`). Switching them
 * to arrow properties would force contravariant checks and break that plug-in.
 */
export interface CdpSession {
   send(method: string, params?: Record<string, unknown>): Promise<unknown>;
   on(event: string, handler: (payload: unknown) => void): void;
   off?(event: string, handler: (payload: unknown) => void): void;
}

/** CDP `Performance.getMetrics` metric name → the {@link BrowserRuntimeSample} field it populates. */
const CDP_METRIC_FIELDS: Readonly<Record<string, keyof BrowserRuntimeSample>> = {
   JSHeapUsedSize: 'jsHeapUsedBytes',
   JSHeapTotalSize: 'jsHeapTotalBytes',
   Nodes: 'nodes',
   JSEventListeners: 'jsEventListeners',
   Documents: 'documents',
   Frames: 'frames',
   LayoutCount: 'layoutCount',
   RecalcStyleCount: 'recalcStyleCount'
};

/** Numeric fields of a {@link BrowserRuntimeSample} — the CDP counters + JS-heap, which alone carry a delta. */
const NUMERIC_SAMPLE_FIELDS: readonly (keyof BrowserRuntimeSample)[] = Object.values(CDP_METRIC_FIELDS);

/** Default filename for the CDP renderer heap snapshot — the browser counterpart to the server's `server-heap`. */
export const BROWSER_HEAP_SNAPSHOT_FILE = 'browser-heap.heapsnapshot';

/**
 * Capture a renderer sample via CDP `Performance.getMetrics` (enabling the domain
 * first). Maps the CDP `{name, value}` list onto the named {@link BrowserRuntimeSample}
 * fields — `nodes`/`jsEventListeners`/`documents`/`frames`/`layoutCount`/
 * `recalcStyleCount` + JS-heap used/total the `performance.memory` triple cannot
 * give — omitting counters the runtime did not report.
 */
export async function captureBrowserRuntimeSample(cdp: CdpSession): Promise<BrowserRuntimeSample> {
   await cdp.send('Performance.enable');
   try {
      const result = (await cdp.send('Performance.getMetrics')) as { metrics?: { name: string; value: number }[] };
      const sample: BrowserRuntimeSample = {};
      for (const metric of result.metrics ?? []) {
         const field = CDP_METRIC_FIELDS[metric.name];
         if (field !== undefined) {
            sample[field] = metric.value;
         }
      }
      return sample;
   } finally {
      // Balance the enable so the domain is not left on for the session's lifetime.
      await cdp.send('Performance.disable').catch(() => undefined);
   }
}

/** Per-field `after − before` for the numeric counters present in BOTH samples; others are omitted. */
export function browserRuntimeDelta(before: BrowserRuntimeSample, after: BrowserRuntimeSample): BrowserRuntimeSample {
   const delta: BrowserRuntimeSample = {};
   for (const field of NUMERIC_SAMPLE_FIELDS) {
      const from = before[field];
      const to = after[field];
      if (typeof from === 'number' && typeof to === 'number') {
         delta[field] = to - from;
      }
   }
   return delta;
}

/**
 * Capture the renderer's V8 heap snapshot via CDP `HeapProfiler.takeHeapSnapshot`
 * (enabling the domain first) — the browser counterpart to the server's
 * `server-heap.heapsnapshot`, giving the renderer the same retained-object-graph
 * view. The snapshot streams as `addHeapSnapshotChunk` events; the chunks are
 * concatenated and written to `sessionDir/<fileName>`. Returns the filename.
 */
export async function captureBrowserHeapSnapshot(
   cdp: CdpSession,
   sessionDir: string,
   fileName: string = BROWSER_HEAP_SNAPSHOT_FILE
): Promise<string> {
   await cdp.send('HeapProfiler.enable');
   const chunks: string[] = [];
   const onChunk = (payload: unknown): void => {
      const chunk = (payload as { chunk?: string }).chunk;
      if (typeof chunk === 'string') {
         chunks.push(chunk);
      }
   };
   cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
   try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
   } finally {
      cdp.off?.('HeapProfiler.addHeapSnapshotChunk', onChunk);
      // Balance the enable so the domain is not left on for the session's lifetime.
      await cdp.send('HeapProfiler.disable').catch(() => undefined);
   }
   writeFileSync(join(sessionDir, fileName), chunks.join(''));
   return fileName;
}

/*
 * The recorder is stashed on `window` under `__hydraniumBrowserTimeline__` so it
 * survives between the two `page.evaluate` calls. The key is inlined as a string
 * literal in each evaluate body (a module const can't cross into the page context).
 */

// Structural page-side globals — used only inside `page.evaluate` bodies (which run
// in the browser), so they carry no DOM-lib dependency into this node-side module.
interface PageEntry {
   name: string;
   entryType: string;
   startTime: number;
   duration: number;
}
interface PageObserver {
   observe(options: { entryTypes: string[] }): void;
   disconnect(): void;
}
interface PageObserverCtor {
   new (callback: (list: { getEntries(): PageEntry[] }) => void): PageObserver;
   supportedEntryTypes?: string[];
}
interface PagePerformance {
   measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: unknown }>;
   memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}
interface TimelineHandle {
   entries: BrowserTimelineEntry[];
   observer?: PageObserver;
}

/**
 * Start recording the main-thread timeline in the page — call BEFORE the scenario
 * body so long tasks + user-timing spans accrue during it. Installs a
 * `PerformanceObserver` (for the entry types the runtime supports, so it degrades
 * cleanly where `longtask` is absent) and stashes it on `window` for
 * {@link bridgeBrowserState} to stop. A no-op observer when no type is supported.
 */
export async function startBrowserTimeline(page: EvaluatablePage): Promise<void> {
   await page.evaluate(() => {
      const key = '__hydraniumBrowserTimeline__';
      const scope = globalThis as unknown as Record<string, unknown>;
      const entries: BrowserTimelineEntry[] = [];
      const handle: TimelineHandle = { entries };
      const ObserverCtor = (globalThis as unknown as { PerformanceObserver?: PageObserverCtor }).PerformanceObserver;
      const supported = ObserverCtor?.supportedEntryTypes ?? [];
      const types = ['longtask', 'measure'].filter(type => supported.includes(type));
      if (ObserverCtor && types.length > 0) {
         const observer = new ObserverCtor(list => {
            for (const entry of list.getEntries()) {
               entries.push({ name: entry.name, entryType: entry.entryType, startTimeMs: entry.startTime, durationMs: entry.duration });
            }
         });
         observer.observe({ entryTypes: types });
         handle.observer = observer;
      }
      scope[key] = handle;
   });
}

/**
 * Capture the browser-origin state AFTER the scenario body — the renderer runtime
 * (precise `measureUserAgentSpecificMemory`, else coarse `performance.memory`, else
 * `unavailable`) as a single-point {@link BrowserRuntimeReport} plus the timeline
 * collected since {@link startBrowserTimeline} (stopping its observer) — and write
 * `browser-timeline.json` into `sessionDir`. The runtime report is RETURNED (not
 * written) so the caller can supersede it with the richer two-point CDP report
 * before writing the single `browser-runtime.json`.
 */
export async function bridgeBrowserState(page: EvaluatablePage, sessionDir: string): Promise<BrowserStateReport> {
   const state = await page.evaluate<BrowserStateReport>(async () => {
      const key = '__hydraniumBrowserTimeline__';
      const scope = globalThis as unknown as Record<string, TimelineHandle | undefined>;
      const perf = (globalThis as unknown as { performance?: PagePerformance }).performance;
      let runtime: BrowserRuntimeReport = { source: 'unavailable', after: {} };
      if (perf?.measureUserAgentSpecificMemory) {
         try {
            const result = await perf.measureUserAgentSpecificMemory();
            runtime = { source: 'measureUserAgentSpecificMemory', after: { totalBytes: result.bytes, breakdown: result.breakdown } };
         } catch {
            // COI missing or rate-limited — fall through to the coarse fallback.
         }
      }
      if (runtime.source === 'unavailable' && perf?.memory) {
         runtime = {
            source: 'performance.memory',
            after: {
               jsHeapUsedBytes: perf.memory.usedJSHeapSize,
               jsHeapTotalBytes: perf.memory.totalJSHeapSize,
               jsHeapLimitBytes: perf.memory.jsHeapSizeLimit
            }
         };
      }
      const handle = scope[key];
      handle?.observer?.disconnect();
      const timeline = handle ? [...handle.entries] : [];
      return { runtime, timeline };
   });
   writeFileSync(join(sessionDir, 'browser-timeline.json'), JSON.stringify(state.timeline, undefined, 2));
   return state;
}
