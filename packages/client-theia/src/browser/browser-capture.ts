/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Browser-origin capture — what page JS can reach without DevTools attached (it
 * cannot start a V8 CPU/heap profile). Produces a single-point renderer-runtime
 * report (memory, source-graded). The shared report shape lives in
 * `@hydranium/protocol` so this live capture and the Playwright CDP bridge produce
 * the SAME `browser-runtime.json`. The main-thread timeline is an e2e-only signal,
 * captured by the CDP bridge; deep renderer CPU/heap profiling stays a manual
 * DevTools activity.
 */

import type { BrowserRuntimeReport } from '@hydranium/protocol';

interface MemoryCapablePerformance {
   measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: unknown }>;
   memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}

/**
 * Capture the renderer runtime as a single-point {@link BrowserRuntimeReport}
 * (`after`-only — the live gauge read). Prefers the standardized
 * `performance.measureUserAgentSpecificMemory()` (precise, by type + container, but
 * requires cross-origin isolation and is rate-limited), falling back to Chrome's
 * coarse `performance.memory` (JS-heap gauge), then to `unavailable`. The two-point
 * CDP source (`nodes`/`jsEventListeners`/… + delta) is the e2e bridge's job.
 */
export async function captureBrowserRuntime(): Promise<BrowserRuntimeReport> {
   const perf = globalThis.performance as (Performance & MemoryCapablePerformance) | undefined;
   if (perf?.measureUserAgentSpecificMemory) {
      try {
         const result = await perf.measureUserAgentSpecificMemory();
         return { source: 'measureUserAgentSpecificMemory', after: { totalBytes: result.bytes, breakdown: result.breakdown } };
      } catch {
         // COI missing or rate-limited — fall through to the coarse fallback.
      }
   }
   if (perf?.memory) {
      return {
         source: 'performance.memory',
         after: {
            jsHeapUsedBytes: perf.memory.usedJSHeapSize,
            jsHeapTotalBytes: perf.memory.totalJSHeapSize,
            jsHeapLimitBytes: perf.memory.jsHeapSizeLimit
         }
      };
   }
   return { source: 'unavailable', after: {} };
}

function mb(bytes: number): string {
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a {@link BrowserRuntimeReport} as a one-line summary for a channel / toast. */
export function formatBrowserRuntime(report: BrowserRuntimeReport): string {
   const { after } = report;
   if (report.source === 'measureUserAgentSpecificMemory' && after.totalBytes !== undefined) {
      return `Browser renderer memory (precise): ${mb(after.totalBytes)} total across JS/DOM/workers.`;
   }
   if (report.source === 'performance.memory' && after.jsHeapUsedBytes !== undefined) {
      const used = after.jsHeapUsedBytes;
      const total = after.jsHeapTotalBytes ?? 0;
      const limit = after.jsHeapLimitBytes ?? 0;
      return `Browser JS heap: ${mb(used)} used / ${mb(total)} total / ${mb(limit)} limit (JS heap only, not the full renderer).`;
   }
   return 'Browser memory info unavailable (non-Chromium, or performance.memory disabled / cross-origin isolation off).';
}
