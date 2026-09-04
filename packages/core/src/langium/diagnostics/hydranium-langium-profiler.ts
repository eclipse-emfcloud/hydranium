/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format, Logger, type Tracer } from '@hydranium/protocol';
import {
   DefaultLangiumProfiler,
   DocumentState,
   MultiMap,
   type ProfilingCategory,
   type ProfilingRecord,
   ProfilingTask
} from '@hydranium/langium';
import { type LogNameOptions } from './logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';

/** Langium's full profiling-category set — the default window {@link HydraniumLangiumProfiler.flush} aggregates. */
const ALL_CATEGORIES: readonly ProfilingCategory[] = ['parsing', 'linking', 'validating'];

/** Construction options for {@link HydraniumLangiumProfiler}. */
export interface LangiumProfilerOptions extends LogNameOptions {
   /**
    * Categories profiled while active. Defaults (via the base
    * {@link DefaultLangiumProfiler}) to Langium's full set when omitted.
    */
   readonly activeCategories?: Set<ProfilingCategory>;
   /**
    * Priority of the per-build flush pass at the `Validated` phase. The flush is
    * normally the only pass at `Validated`, so order is immaterial; the option
    * exists for symmetry with the other framework passes. Default
    * {@link PROFILER_FLUSH_PASS_PRIORITY}.
    */
   readonly flushPriority?: number;
}

/** Default priority of the profiler's per-build flush pass (see {@link LangiumProfilerOptions.flushPriority}). */
export const PROFILER_FLUSH_PASS_PRIORITY = 0;

/**
 * Framework adapter over Langium's {@link DefaultLangiumProfiler} that is
 * **trace-gated** and emits a single **aggregated** per-category breakdown
 * once per build through the framework {@link Tracer}, instead of one
 * `console.table` dump per document.
 *
 *  - **Aggregate, not per-document.** Langium creates one profiling task per
 *    document (`createTask('validating', languageId)`) and the stock
 *    {@link DefaultLangiumProfiler.dumpRecord} prints each as it completes —
 *    dozens of near-identical blocks, all labelled with the language id (the
 *    task identifier), so the per-document records carry no distinguishing
 *    information anyway. We instead accumulate records in {@link records} and
 *    {@link flush} one breakdown per category — self-time and invocation counts
 *    summed per `$type` across the whole build — on the terminal `Validated`
 *    build phase (self-registered in the constructor). One report per build, not
 *    one per file.
 *  - **Transport safety.** The stock per-record dump uses `console.table`, which
 *    is NOT in the set `patchConsole` reroutes; under `vscode-languageserver`'s
 *    `--stdio` transport `process.stdout` *is* the JSON-RPC channel, so the
 *    native ASCII grid corrupts the protocol stream. {@link createTask} bypasses
 *    `dumpRecord` entirely (records are stored, never grid-printed); {@link flush}
 *    emits one {@link Tracer} line per row.
 *  - **Opt-in / no production cost.** {@link isActive} is gated on the global
 *    `trace` threshold, so at the default `info` level (and even at `debug`)
 *    every Langium parse/link/validate guard (`profiler?.isActive(category)`)
 *    short-circuits to `false` and no task is ever created. The per-`$type`
 *    self-time is high-volume diagnostic detail, so it sits at the `trace` tier
 *    deliberately — `debug` keeps the readable one-line-per-phase
 *    `DocumentBuilder` overview without this spam. The gate is evaluated per
 *    call, so flipping the level at runtime turns profiling on/off without a
 *    restart. Langium's own `start`/`stop` category selection still applies *on
 *    top of* the trace gate.
 *
 * Registered eagerly (see `DEFAULT_EAGER_SERVICES`) so its `Validated`-phase
 * flush pass is registered before the first build. Gives the per-grammar-rule /
 * per-`$type` parse/link/validate self-time the framework's own
 * `ServerTracer` / `ProfileSession` passes
 * cannot produce (those cover the framework's passes *outside* Langium's
 * parse/link/validate categories).
 */
export class HydraniumLangiumProfiler extends DefaultLangiumProfiler {
   /** Component-tagged tracer (`LangiumProfiler`); the per-category tag is added per flush. */
   protected readonly tracer: Tracer;

   constructor(services: ServerSharedServicesMinimal, options: LangiumProfilerOptions = {}) {
      super(options.activeCategories);
      this.tracer = services.Tracer.for(options.logName ?? 'LangiumProfiler').trace('instantiated');
      // Flush once per build on the terminal phase rather than once per document.
      // By `Validated`, every parse/link/validate record for the batch is in.
      // Registered as a build-phase pass (not a direct onBuildPhase listener) so
      // every framework + adopter build-phase reaction shares one dispatcher.
      services.workspace.BuildPhasePassService.register({
         id: 'framework:langium-profiler:flush',
         state: DocumentState.Validated,
         priority: options.flushPriority ?? PROFILER_FLUSH_PASS_PRIORITY,
         run: () => this.flush()
      });
   }

   /**
    * A category profiles only while the global threshold admits `trace` *and*
    * Langium's category selection has it active. The trace gate is the master
    * switch (zero cost at `info`/`debug`); the category set is the sub-selection.
    */
   override isActive(category: ProfilingCategory): boolean {
      return Logger.isLevelEnabled('trace') && super.isActive(category);
   }

   /**
    * Accumulate each completed task's record in {@link records} for the
    * end-of-build {@link flush}. Bypasses the base's `console.table`
    * {@link DefaultLangiumProfiler.dumpRecord} (the `--stdio` hazard) — records
    * are stored, never grid-printed.
    */
   override createTask(category: ProfilingCategory, taskId: string): ProfilingTask {
      if (!this.isActive(category)) {
         throw new Error(`Category "${category}" is not active.`);
      }
      return new ProfilingTask(record => this.records.add(category, this.captureRecord(record)), taskId);
   }

   /**
    * Snapshot a completed record's `entries` into an independent {@link MultiMap}.
    * {@link ProfilingTask.stop} clears its `entries` immediately after invoking
    * this callback, and the record holds that map by reference — so the read
    * MUST happen now (the stock `dumpRecord` reads synchronously here too).
    * Deferring to {@link flush} without this copy would see emptied entries.
    */
   protected captureRecord(record: ProfilingRecord): ProfilingRecord {
      const entries = new MultiMap<string, number>();
      for (const key of record.entries.keys()) {
         for (const value of record.entries.get(key)) {
            entries.add(key, value);
         }
      }
      return { ...record, entries };
   }

   /**
    * Emit one aggregated breakdown per category — self-time and invocation
    * counts summed per `<languageId>.<$type>` across every record collected
    * this build — then clear the window. Self-registered as a `Validated`-phase
    * build pass, so it fires once per build, not per document. Pass explicit
    * categories to flush a subset; defaults to all.
    *
    * `flush` is the sole reset point: because it clears each flushed category,
    * memory is bounded per completed build. A build cancelled before `Validated`
    * leaves its partial records to roll into the next build's flush (slightly
    * inflated counts, self-correcting) rather than accumulating without bound.
    */
   flush(...categories: ProfilingCategory[]): void {
      const toFlush = categories.length > 0 ? categories : ALL_CATEGORIES;
      for (const category of toFlush) {
         const records = this.getRecords(category).toArray();
         if (records.length === 0) {
            continue;
         }
         const totals = new Map<string, { count: number; selfMs: number }>();
         let totalMs = 0;
         for (const record of records) {
            totalMs += record.duration;
            for (const key of record.entries.keys()) {
               const name = `${record.identifier}.${key}`;
               const values = record.entries.get(key);
               const aggregate = totals.get(name) ?? { count: 0, selfMs: 0 };
               aggregate.count += values.length;
               aggregate.selfMs += values.reduce((sum, value) => sum + value, 0);
               totals.set(name, aggregate);
            }
         }
         const rows = [...totals.entries()]
            .map(([name, aggregate]) => ({ name, ...aggregate }))
            .sort((left, right) => right.selfMs - left.selfMs);

         const log = this.tracer.sub(category);
         log.trace(`${category}: ${records.length} docs, ${Format.elapsed(totalMs)} total`);
         for (const row of rows) {
            const pct = totalMs > 0 ? Math.round((100 * row.selfMs) / totalMs) : 0;
            log.trace(`${row.name} ×${row.count} ${pct}% ${Format.elapsed(row.selfMs)}`);
         }
         this.records.delete(category);
      }
   }
}
