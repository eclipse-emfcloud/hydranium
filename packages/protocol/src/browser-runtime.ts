/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Browser-origin renderer-capture shapes. They live in `@hydranium/protocol`
 * (neutral — no DOM, no `node:` deps) so the client-theia live capture
 * (`captureBrowserRuntime`) and the Playwright CDP bridge produce the SAME
 * `browser-runtime.json` artefact type. One report with `source`-graded
 * fidelity, so a reader has one shape and one file to interpret.
 */

/**
 * One renderer-runtime reading — JS-heap + precise-renderer-memory + object/render
 * counters, every field optional (a counter a source cannot produce is omitted).
 */
export interface BrowserRuntimeSample {
   /** JS heap used (CDP `JSHeapUsedSize` / `performance.memory.usedJSHeapSize`). */
   jsHeapUsedBytes?: number;
   /** JS heap total (CDP `JSHeapTotalSize` / `performance.memory.totalJSHeapSize`). */
   jsHeapTotalBytes?: number;
   /** JS heap limit (`performance.memory.jsHeapSizeLimit`; CDP does not report it). */
   jsHeapLimitBytes?: number;
   /** Total renderer memory across JS/DOM/workers (`measureUserAgentSpecificMemory` only). */
   totalBytes?: number;
   /** The precise API's per-type/per-container breakdown, passed through verbatim. */
   breakdown?: unknown;
   /** DOM node count (CDP `Nodes`) — a rising count is the classic Theia leak tell. */
   nodes?: number;
   /** Registered JS event listeners (CDP `JSEventListeners`) — the other leak tell. */
   jsEventListeners?: number;
   /** Live `Document` count (CDP `Documents`). */
   documents?: number;
   /** Frame count (CDP `Frames`). */
   frames?: number;
   /** Cumulative layout operations (CDP `LayoutCount`). */
   layoutCount?: number;
   /** Cumulative style recalculations (CDP `RecalcStyleCount`). */
   recalcStyleCount?: number;
}

/**
 * The `browser-runtime.json` artefact — renderer memory + object/render counters,
 * graded by `source`. `before`/`after`/`delta` are present for a two-point source
 * (CDP, before vs after the scenario — the delta is the leak signal); `after`-only
 * for a single gauge read (the live "Dump Frontend State" command).
 *
 *  - `cdp-performance` — full: JS heap + `nodes`/`jsEventListeners`/`documents`/
 *    `frames`/`layoutCount`/`recalcStyleCount`; two-point.
 *  - `measureUserAgentSpecificMemory` — precise renderer bytes by type/container
 *    (`totalBytes`/`breakdown`; cross-origin isolation only); after-only.
 *  - `performance.memory` — JS-heap gauge only (used/total/limit); after-only.
 *  - `unavailable` — neither API; `after` is empty.
 */
export interface BrowserRuntimeReport {
   /**
    * Which API produced the reading, and therefore which sample fields CAN be
    * populated — a reader must branch on it rather than assume a field is
    * missing because the value was zero. Not a caller preference: each producer
    * tries its best source and degrades, so the same code path can emit any of
    * the four across runs.
    */
   source: 'cdp-performance' | 'measureUserAgentSpecificMemory' | 'performance.memory' | 'unavailable';
   /**
    * The pre-scenario reading, present only for a two-point capture. Its absence
    * is what marks a report as a single gauge read, and {@link delta} is then
    * absent with it.
    */
   before?: BrowserRuntimeSample;
   /**
    * The post-scenario reading, or the only reading for a single-point capture.
    * Always present — an `unavailable` source yields an EMPTY object here rather
    * than omitting the field, so presence proves nothing about content.
    */
   after: BrowserRuntimeSample;
   /**
    * Per-field `after − before`, computed only for the numeric CDP counters and
    * only where both samples carry the field, so a counter can appear in
    * {@link after} and be absent here. Positive means growth over the scenario,
    * which on `nodes` or `jsEventListeners` is the leak signal the two-point
    * capture exists for.
    */
   delta?: BrowserRuntimeSample;
}

/** One main-thread timeline entry — a `longtask` (jank) or a user-timing `measure` span. */
export interface BrowserTimelineEntry {
   /**
    * The runtime's own label — an attribution name for a long task, the app's
    * mark name for a user-timing span. Not unique: one name recurs once per
    * occurrence.
    */
   name: string;
   /**
    * The `PerformanceEntry` type. Only `longtask` and `measure` are observed,
    * and only where the runtime lists them as supported — but the field is left
    * open rather than a union, because it carries whatever the entry reported.
    */
   entryType: string;
   /**
    * Milliseconds from the PAGE's time origin (the `performance.now` domain).
    * Not wall-clock: it cannot be compared with a server timestamp, with a
    * `Date.now` reading, or with an entry captured from another page.
    */
   startTimeMs: number;
   /**
    * Milliseconds the entry spanned — main-thread blocking time for a long
    * task, which the platform only reports above 50ms, and the mark-to-mark
    * span for a `measure`.
    */
   durationMs: number;
}

/** Both browser-origin signals of one capture — the runtime report and the main-thread timeline. */
export interface BrowserStateReport {
   /**
    * The page-side single-point read taken at capture time. A caller holding a
    * CDP session is expected to supersede it with the richer two-point report
    * before writing `browser-runtime.json`, so this field is the floor rather
    * than the final artefact.
    */
   runtime: BrowserRuntimeReport;
   /**
    * Entries in observer-delivery order, covering the span between starting the
    * recorder and this capture. Empty carries two meanings this shape cannot
    * separate — nothing janked, or the recorder was never started and the
    * runtime supports neither entry type.
    */
   timeline: BrowserTimelineEntry[];
}
