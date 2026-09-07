/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Stopwatch } from './clock';
import { Format, Logger, type LogThreshold } from './logger';

/** One aggregated row of a {@link ProfileSession}: a scope id and its totals. */
export interface ProfileRecord {
   /** The scope id passed to {@link ProfileSession.scope}. */
   id: string;
   /** How many times a scope with this id ran. */
   count: number;
   /** Summed self-time across those runs (wall-clock minus nested scopes). */
   selfMs: number;
   /** Self-time as a percentage of the session's total wall-clock. */
   selfPct: number;
}

/**
 * An aggregating, parent-exclusive self-time profiler scoped to one operation.
 *
 * Unlike `Tracer.time`, which emits one log line per
 * call and keeps the timeline, a {@link ProfileSession} collapses many
 * {@link scope} calls into a compact per-id aggregate (count + self-time +
 * self-%), then dumps it as line-based output through a {@link Logger}. It is
 * the in-house analogue of Langium's `ProfilingTask` (per-rule / per-node-type
 * self-time) but for the framework's own passes — integrity rules, GModel
 * construction, the save/reconcile chain — that Langium's profiler does not
 * cover.
 *
 * Spawned per operation via `tracer.profile(id)`, used, reported, discarded —
 * it is stateful and op-scoped, which is why it is not a method on the
 * long-lived {@link Logger}/`Tracer`.
 */
export interface ProfileSession {
   /**
    * Run `fn` as a measured task `id`, accumulating its self-time = wall-clock
    * minus any nested {@link scope} calls. Re-entrant: an inner scope nests and
    * its full duration is excluded from the enclosing id's self-time
    * (parent-exclusive). Async `fn` is awaited so timing covers the full
    * settle. Returns `fn`'s result unchanged; rethrows after recording the
    * elapsed time of a throwing scope.
    */
   scope<T>(id: string, fn: () => Promise<T>): Promise<T>;
   scope<T>(id: string, fn: () => T): T;

   /**
    * Emit the aggregate through the bound {@link Logger}: one line per id,
    * sorted by self-time descending, plus an "unaccounted" remainder (the
    * session wall-clock not attributed to any top-level scope). No-op when
    * `logLevel` is suppressed by the global threshold (incl. `'off'`).
    */
   report(logLevel?: LogThreshold): void;

   /** The same aggregate as structured records, for tests / programmatic use. */
   records(): readonly ProfileRecord[];
}

interface ScopeFrame {
   readonly id: string;
   /** Session-stopwatch reading when this scope began. */
   readonly start: number;
   /** Wall-time consumed by nested scopes, excluded from this scope's self-time. */
   childMs: number;
}

/**
 * Default {@link ProfileSession}. Times against an injected {@link Clock} (so
 * it is fake-clock deterministic in tests, unlike a raw `performance.now`) and
 * dumps through an injected {@link Logger}.
 */
export class DefaultProfileSession implements ProfileSession {
   /** Single monotonic timeline for the whole session; per-scope readings are deltas off it. */
   protected readonly sessionStopwatch: Stopwatch;
   protected readonly stack: ScopeFrame[] = [];
   protected readonly entries = new Map<string, number[]>();

   constructor(
      protected readonly logger: Logger,
      clock: Clock,
      protected readonly identifier: string
   ) {
      this.sessionStopwatch = clock.stopwatch();
   }

   scope<T>(id: string, fn: () => Promise<T>): Promise<T>;
   scope<T>(id: string, fn: () => T): T;
   scope<T>(id: string, fn: () => T | Promise<T>): T | Promise<T> {
      const frame: ScopeFrame = { id, start: this.sessionStopwatch.elapsedMs, childMs: 0 };
      this.stack.push(frame);
      let result: T | Promise<T>;
      try {
         result = fn();
      } catch (error) {
         this.closeFrame(frame);
         throw error;
      }
      if (result instanceof Promise) {
         return result.then(
            value => {
               this.closeFrame(frame);
               return value;
            },
            error => {
               this.closeFrame(frame);
               throw error;
            }
         );
      }
      this.closeFrame(frame);
      return result;
   }

   /** Pop `frame`, charge its full duration to the parent, and record its self-time. */
   protected closeFrame(frame: ScopeFrame): void {
      this.stack.pop();
      const duration = this.sessionStopwatch.elapsedMs - frame.start;
      const parent = this.stack[this.stack.length - 1];
      if (parent) {
         parent.childMs += duration;
      }
      const selfMs = duration - frame.childMs;
      const samples = this.entries.get(frame.id);
      if (samples) {
         samples.push(selfMs);
      } else {
         this.entries.set(frame.id, [selfMs]);
      }
   }

   records(): readonly ProfileRecord[] {
      const totalMs = this.sessionStopwatch.elapsedMs;
      const records: ProfileRecord[] = [];
      for (const [id, samples] of this.entries) {
         const selfMs = samples.reduce((sum, value) => sum + value, 0);
         records.push({ id, count: samples.length, selfMs, selfPct: totalMs > 0 ? (100 * selfMs) / totalMs : 0 });
      }
      return records.sort((left, right) => right.selfMs - left.selfMs);
   }

   report(logLevel: LogThreshold = 'debug'): void {
      if (logLevel === 'off' || !Logger.isLevelEnabled(logLevel)) {
         return;
      }
      const totalMs = this.sessionStopwatch.elapsedMs;
      const records = this.records();
      const emit = this.logger[logLevel].bind(this.logger);
      for (const record of records) {
         emit(`[profile ${this.identifier}] ${record.id} ×${record.count} ${Math.round(record.selfPct)}% ${Format.elapsed(record.selfMs)}`);
      }
      const accountedMs = records.reduce((sum, record) => sum + record.selfMs, 0);
      const unaccountedMs = totalMs - accountedMs;
      if (unaccountedMs >= 0.5) {
         const pct = totalMs > 0 ? Math.round((100 * unaccountedMs) / totalMs) : 0;
         emit(`[profile ${this.identifier}] (unaccounted) ${pct}% ${Format.elapsed(unaccountedMs)}`);
      }
   }
}
