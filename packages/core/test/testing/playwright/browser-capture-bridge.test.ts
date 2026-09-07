/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
   bridgeBrowserState,
   browserRuntimeDelta,
   captureBrowserHeapSnapshot,
   captureBrowserRuntimeSample,
   type CdpSession,
   type EvaluatablePage,
   startBrowserTimeline
} from '../../../src/testing/playwright/browser-capture-bridge.js';

/** A fake Playwright page whose `evaluate` returns canned data instead of running in a browser. */
function fakePage(result: unknown): EvaluatablePage & { calls: number } {
   return {
      calls: 0,
      async evaluate<R>(): Promise<R> {
         this.calls++;
         return result as R;
      }
   };
}

/**
 * A page that RUNS the evaluated function in this process instead of discarding
 * it. Playwright serialises the body and re-runs it in the renderer, so the
 * whole installer — the observer probe, the entry-type filter, the entry
 * mapping, the `__hydraniumBrowserTimeline__` stash the state bridge later reads
 * — lives inside the argument a canned-result fake throws away, and a test built
 * on that fake stays green against `async () => undefined`. Running it here is
 * also the only check that the body is genuinely self-contained: a reference to
 * a module import would throw rather than silently ship a body the renderer
 * cannot evaluate.
 */
function executingPage(): EvaluatablePage & { calls: number } {
   return {
      calls: 0,
      async evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R> {
         this.calls++;
         return pageFunction();
      }
   };
}

interface FakePageEntry {
   name: string;
   entryType: string;
   startTime: number;
   duration: number;
}

/**
 * Stand in for the page's `PerformanceObserver` with a controlled
 * `supportedEntryTypes`, so the filter is exercised against a runtime that
 * lacks `longtask` as well as one that has it — the degradation the installer
 * exists to handle, and one no real Node global would exhibit.
 */
function installFakePerformanceObserver(supportedEntryTypes: readonly string[]): {
   observed: string[][];
   disconnects: number;
   emit(entries: readonly FakePageEntry[]): void;
   restore(): void;
} {
   const observed: string[][] = [];
   const state = { disconnects: 0, callback: undefined as undefined | ((list: { getEntries(): FakePageEntry[] }) => void) };
   class FakeObserver {
      static readonly supportedEntryTypes = [...supportedEntryTypes];
      constructor(callback: (list: { getEntries(): FakePageEntry[] }) => void) {
         state.callback = callback;
      }
      observe(options: { entryTypes: string[] }): void {
         observed.push(options.entryTypes);
      }
      disconnect(): void {
         state.disconnects++;
      }
   }
   const scope = globalThis as unknown as Record<string, unknown>;
   const previous = scope.PerformanceObserver;
   scope.PerformanceObserver = FakeObserver;
   return {
      observed,
      get disconnects(): number {
         return state.disconnects;
      },
      emit(entries: readonly FakePageEntry[]): void {
         state.callback?.({ getEntries: () => [...entries] });
      },
      restore(): void {
         scope.PerformanceObserver = previous;
         delete (globalThis as unknown as Record<string, unknown>).__hydraniumBrowserTimeline__;
      }
   };
}

function timelineHandle(): { entries: unknown[] } | undefined {
   return (globalThis as unknown as Record<string, { entries: unknown[] } | undefined>).__hydraniumBrowserTimeline__;
}

/**
 * A fake CDP session: `Performance.getMetrics` returns the next canned metric map
 * (as CDP's `{name,value}` list), and `HeapProfiler.takeHeapSnapshot` emits the
 * canned chunks to the registered `addHeapSnapshotChunk` listener.
 */
function fakeCdp(options: { metrics?: Record<string, number>[]; snapshotChunks?: string[] } = {}): CdpSession & { sent: string[] } {
   const listeners = new Map<string, ((payload: unknown) => void)[]>();
   let metricsCall = 0;
   const sent: string[] = [];
   return {
      sent,
      async send(method: string): Promise<unknown> {
         sent.push(method);
         if (method === 'Performance.getMetrics') {
            const values = options.metrics?.[metricsCall++] ?? {};
            return { metrics: Object.entries(values).map(([name, value]) => ({ name, value })) };
         }
         if (method === 'HeapProfiler.takeHeapSnapshot') {
            for (const chunk of options.snapshotChunks ?? []) {
               for (const handler of listeners.get('HeapProfiler.addHeapSnapshotChunk') ?? []) {
                  handler({ chunk });
               }
            }
         }
         return {};
      },
      on(event: string, handler: (payload: unknown) => void): void {
         listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
      off(event: string, handler: (payload: unknown) => void): void {
         listeners.set(
            event,
            (listeners.get(event) ?? []).filter(existing => existing !== handler)
         );
      }
   };
}

describe('bridgeBrowserState', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-bridge-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('writes browser-timeline.json and returns the runtime report from the page evaluate result', async () => {
      const captured = {
         runtime: { source: 'performance.memory', after: { jsHeapUsedBytes: 10, jsHeapTotalBytes: 20, jsHeapLimitBytes: 40 } },
         timeline: [{ name: 'jank', entryType: 'longtask', startTimeMs: 5, durationMs: 120 }]
      };
      const page = fakePage(captured);
      const state = await bridgeBrowserState(page, dir);
      expect(state).toEqual(captured);
      expect(JSON.parse(readFileSync(join(dir, 'browser-timeline.json'), 'utf8'))).toEqual(captured.timeline);
   });
});

describe('startBrowserTimeline', () => {
   let observer: ReturnType<typeof installFakePerformanceObserver> | undefined;
   afterEach(() => {
      observer?.restore();
      observer = undefined;
   });

   it('observes the supported entry types and maps delivered entries into the page stash', async () => {
      observer = installFakePerformanceObserver(['longtask', 'measure', 'mark']);

      await startBrowserTimeline(executingPage());

      expect(observer.observed).toEqual([['longtask', 'measure']]); // 'mark' is supported but not wanted
      expect(timelineHandle()?.entries).toEqual([]);

      observer.emit([{ name: 'jank', entryType: 'longtask', startTime: 5, duration: 120 }]);

      expect(timelineHandle()?.entries).toEqual([{ name: 'jank', entryType: 'longtask', startTimeMs: 5, durationMs: 120 }]);
   });

   it('narrows the observed types to those the runtime supports', async () => {
      observer = installFakePerformanceObserver(['measure']);

      await startBrowserTimeline(executingPage());

      expect(observer.observed).toEqual([['measure']]);
   });

   it('stashes an empty handle and constructs no observer when no wanted type is supported', async () => {
      observer = installFakePerformanceObserver(['mark']);

      await startBrowserTimeline(executingPage());

      expect(observer.observed).toEqual([]);
      expect(timelineHandle()?.entries).toEqual([]);
   });

   it('hands the collected entries to bridgeBrowserState and disconnects the observer', async () => {
      observer = installFakePerformanceObserver(['longtask']);
      const dir = mkdtempSync(join(tmpdir(), 'hydranium-timeline-'));
      try {
         const page = executingPage();
         await startBrowserTimeline(page);
         observer.emit([{ name: 'slow', entryType: 'longtask', startTime: 1, duration: 90 }]);

         const state = await bridgeBrowserState(page, dir);

         expect(state.timeline).toEqual([{ name: 'slow', entryType: 'longtask', startTimeMs: 1, durationMs: 90 }]);
         expect(observer.disconnects).toBe(1);
         expect(JSON.parse(readFileSync(join(dir, 'browser-timeline.json'), 'utf8'))).toEqual(state.timeline);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });
});

describe('captureBrowserRuntimeSample', () => {
   it('enables the CDP Performance domain and maps getMetrics into a browser runtime sample', async () => {
      const cdp = fakeCdp({
         metrics: [{ JSHeapUsedSize: 100, JSHeapTotalSize: 200, Nodes: 5, JSEventListeners: 3, Documents: 2, Frames: 1 }]
      });
      const sample = await captureBrowserRuntimeSample(cdp);
      expect(cdp.sent).toContain('Performance.enable');
      expect(cdp.sent).toContain('Performance.getMetrics');
      expect(sample).toMatchObject({ jsHeapUsedBytes: 100, jsHeapTotalBytes: 200, nodes: 5, jsEventListeners: 3, documents: 2, frames: 1 });
   });

   it('omits counters the runtime did not report', async () => {
      const cdp = fakeCdp({ metrics: [{ Nodes: 7 }] });
      const sample = await captureBrowserRuntimeSample(cdp);
      expect(sample.nodes).toBe(7);
      expect(sample.jsHeapUsedBytes).toBeUndefined();
   });
});

describe('browserRuntimeDelta', () => {
   it('subtracts only the counters present in both samples', () => {
      const delta = browserRuntimeDelta({ nodes: 5, jsHeapUsedBytes: 100 }, { nodes: 8, jsHeapUsedBytes: 130, frames: 2 });
      expect(delta).toEqual({ nodes: 3, jsHeapUsedBytes: 30 });
   });
});

describe('captureBrowserHeapSnapshot', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-cdp-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('enables the CDP HeapProfiler and writes the streamed chunks to a browser .heapsnapshot', async () => {
      const cdp = fakeCdp({ snapshotChunks: ['{"snapshot":', '{}}'] });
      const file = await captureBrowserHeapSnapshot(cdp, dir);
      expect(file).toBe('browser-heap.heapsnapshot');
      expect(cdp.sent).toContain('HeapProfiler.enable');
      expect(cdp.sent).toContain('HeapProfiler.takeHeapSnapshot');
      expect(readFileSync(join(dir, file), 'utf8')).toBe('{"snapshot":{}}');
   });
});
