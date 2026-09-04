/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, SystemClock } from './clock';
import { Format, Logger, type LogThreshold } from './logger';
import { NoopLogger } from './noop-logger';
import { DefaultProfileSession, type ProfileSession } from './profile-session';
import { Disposable } from './util';

/** Module-global so nested timers don't reuse ids. */
let nextTimerId = 0;

/** Ops completing before this threshold are silent on success — only failures emit a retroactive start. */
export const DEFER_START_MS = 5;

/** Optional settings for {@link Tracer.time}. */
export interface TimeOptions {
   /** Defer the [start] line until the op has run this long. Set to 0 to always log. */
   logAfterMs?: number;
   /** Called with the correlation id before the op runs. */
   captureId?: (id: number) => void;
   /** Extra context included in the status brackets. Read on each emit so callers can mutate. */
   tags?: string[];
   /** Server-only: force the memory suffix on [done] when elapsed >= this many ms, ignoring the delta gate. */
   forceMemoryAboveMs?: number;
}

/** Platform-specific heap readout. Returns `undefined` where unavailable (e.g. a browser outside Chromium). */
export interface MemoryInfo {
   /** Bytes currently in use (heap used / `usedJSHeapSize`). */
   usedBytes: number;
   /** Optional capacity for a "used / total" rendering (heap total / `totalJSHeapSize`). */
   totalBytes?: number;
}

/** Reads the current process/heap memory. The single per-head piece of {@link DefaultTracer}. */
export type MemoryReader = () => MemoryInfo | undefined;

/**
 * Cross-head observability handle: everything a {@link Logger} does (emission,
 * threshold gating, component-prefix derivation) **plus** timing an operation,
 * reading memory, and opening aggregate {@link ProfileSession}s.
 *
 * `Tracer extends Logger` so a service that both logs and times holds a single
 * handle (`this.tracer.debug(...)` / `this.tracer.time(...)`), and a Tracer is
 * usable anywhere a Logger is wanted. The emission-only {@link Logger} stays
 * the lean default for consumers that only log.
 *
 * The variance lives in the loggers (per-platform emit sinks); the Tracer
 * **composes** a Logger and forwards emission to it, so one
 * {@link DefaultTracer} serves every head with no per-platform subclass. The
 * {@link for}/{@link sub}/{@link with}/{@link withUri} derivations produce a
 * child Tracer over the correspondingly-derived logger, so
 * `tracer.withUri(uri).time(...)` emits through that logger's rendering.
 */
export interface Tracer extends Logger {
   /** Read process/heap memory and emit it as a log line. Platform-specific via {@link MemoryReader}. */
   memory(label?: string, logLevel?: LogThreshold): void;
   /**
    * Run `callback`, emit start / completion / failure with timings. Zero-cost
    * when `logLevel` is suppressed (incl. `'off'`).
    *
    * A success completing under {@link TimeOptions.logAfterMs} is **silent** —
    * this is "tell me when it is slow", not "record every occurrence". A caller
    * that wants an unconditional per-occurrence line composes it from
    * `Clock.measure` instead.
    */
   time<T>(label: string, callback: () => T, logLevel?: LogThreshold, options?: TimeOptions): T;
   /** Start a deferred-start timer that logs elapsed on dispose. Zero-cost when `logLevel` is suppressed (incl. `'off'`). */
   startTimer(label: string, logLevel?: LogThreshold, logAfterMs?: number): Disposable;
   /** Open an aggregating self-time {@link ProfileSession} that dumps through the bound Logger. */
   profile(identifier: string): ProfileSession;
   /** Derive a child Tracer with `component` as the logger prefix. */
   for(component: string): this;
   /** Derive a child Tracer deepening the `Foo :: bar` prefix chain. */
   sub(component: string): this;
   /** Derive a child Tracer appending `component` as a separate `[a] [b]` bracket. */
   with(component: string): this;
   /** Derive a child Tracer labelled with the given URI (subclasses may render workspace-relative). */
   withUri(uri: string): this;
}

/**
 * Default cross-head {@link Tracer}. One concrete class serves every head:
 * emission delegates to the composed {@link Logger}, timing/profiling go
 * through the injected {@link Clock}, and the only per-head varying piece is
 * the {@link MemoryReader} (default: none — heads that log memory pass a
 * reader, or subclass for richer rendering, as the server's `ServerTracer`
 * does). The `time` / `startTimer` bodies are zero-cost when the level is
 * suppressed: the callback runs directly and no stopwatch / timer / id is
 * allocated.
 */
export class DefaultTracer implements Tracer {
   constructor(
      protected readonly logger: Logger = new NoopLogger(),
      protected readonly clock: Clock = new SystemClock(),
      protected readonly readMemory: MemoryReader = () => undefined
   ) {}

   // Emission — forwarded to the composed logger (the platform-specific sink).
   // Each returns the Tracer (not the wrapped logger) so chained emits stay on
   // the tracer and `tracer.for(x).trace(y)` yields a Tracer.
   error(message?: string, ...args: unknown[]): this {
      this.logger.error(message, ...args);
      return this;
   }
   warn(message?: string, ...args: unknown[]): this {
      this.logger.warn(message, ...args);
      return this;
   }
   info(message?: string, ...args: unknown[]): this {
      this.logger.info(message, ...args);
      return this;
   }
   debug(message?: string, ...args: unknown[]): this {
      this.logger.debug(message, ...args);
      return this;
   }
   trace(message?: string, ...args: unknown[]): this {
      this.logger.trace(message, ...args);
      return this;
   }
   log(message?: string, ...args: unknown[]): this {
      this.logger.log(message, ...args);
      return this;
   }
   logAt(threshold: LogThreshold, message: string): this {
      this.logger.logAt(threshold, message);
      return this;
   }

   memory(label?: string, logLevel: LogThreshold = 'info'): void {
      if (logLevel === 'off' || !Logger.isLevelEnabled(logLevel)) {
         return;
      }
      const info = this.readMemory();
      if (!info) {
         // No memory stats available — a contentless "Memory:" line is noise.
         return;
      }
      const used = Format.bytes(info.usedBytes);
      const text = info.totalBytes !== undefined ? `${used}/${Format.bytes(info.totalBytes)}` : used;
      this.logger[logLevel](`${label ? `${label}: ` : 'Memory: '}${text}`);
   }

   time<T>(label: string, callback: () => T, logLevel: LogThreshold = 'info', options: TimeOptions = {}): T {
      if (logLevel === 'off' || !Logger.isLevelEnabled(logLevel)) {
         return callback();
      }
      const { logAfterMs = DEFER_START_MS, captureId, tags } = options;
      const id = ++nextTimerId;
      captureId?.(id);
      const stopwatch = this.clock.stopwatch();
      let startEmitted = false;
      let startTimer: Disposable | undefined;
      const currentExtras = (): string => (tags && tags.length > 0 ? `, ${tags.join(', ')}` : '');
      const emitStart = (): void => {
         this.logger[logLevel](`${label} [#${id} start${currentExtras()}]`);
         startEmitted = true;
      };
      if (logAfterMs <= 0) {
         emitStart();
      } else {
         startTimer = this.clock.setTimer(emitStart, logAfterMs);
      }
      const emit = (status: 'done' | 'failed' | 'cancelled', error?: unknown): void => {
         startTimer?.dispose();
         if (!startEmitted) {
            if (status === 'done') {
               return;
            }
            emitStart();
         }
         const elapsed = stopwatch.elapsedMs;
         const suffix = this.timingSuffix(status, elapsed, options);
         this.logger[logLevel](`${label} [#${id} ${status}, ${Format.elapsed(elapsed)}${currentExtras()}${suffix}]`);
         if (status === 'failed') {
            // The timing line above sits at `logLevel`, which may be below the
            // active threshold — and on its own it never carries *why* the op
            // failed. Surface the error at warn so the failure is never silent,
            // with the stack at debug. Cancellations are normal control flow.
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.warn(`${label} [#${id}] failed: ${detail}`);
            if (error instanceof Error && error.stack) {
               this.logger.debug(error.stack);
            }
         }
      };
      let result: T;
      try {
         result = callback();
      } catch (error) {
         emit(this.categorizeError(error), error);
         throw error;
      }
      if (result instanceof Promise) {
         return result.then(
            value => {
               emit('done');
               return value;
            },
            error => {
               emit(this.categorizeError(error), error);
               throw error;
            }
         ) as T;
      }
      emit('done');
      return result;
   }

   startTimer(label: string, logLevel: LogThreshold = 'info', logAfterMs: number = DEFER_START_MS): Disposable {
      if (logLevel === 'off' || !Logger.isLevelEnabled(logLevel)) {
         return Disposable.create(() => {});
      }
      const id = ++nextTimerId;
      const stopwatch = this.clock.stopwatch();
      let startEmitted = false;
      let startTimer: Disposable | undefined;
      const emitStart = (): void => {
         this.logger[logLevel](`${label} [#${id} start]`);
         startEmitted = true;
      };
      if (logAfterMs <= 0) {
         emitStart();
      } else {
         startTimer = this.clock.setTimer(emitStart, logAfterMs);
      }
      return Disposable.create(() => {
         startTimer?.dispose();
         if (!startEmitted) {
            return;
         }
         const elapsed = stopwatch.elapsedMs;
         const suffix = this.timingSuffix('done', elapsed, {});
         this.logger[logLevel](`${label} [#${id} done, ${Format.elapsed(elapsed)}${suffix}]`);
      });
   }

   profile(identifier: string): ProfileSession {
      return new DefaultProfileSession(this.logger, this.clock, identifier);
   }

   for(component: string): this {
      return this.derive(this.logger.for(component));
   }
   sub(component: string): this {
      return this.derive(this.logger.sub(component));
   }
   with(component: string): this {
      return this.derive(this.logger.with(component));
   }
   withUri(uri: string): this {
      return this.derive(this.logger.withUri(uri));
   }

   /** Construct a sibling Tracer over a derived logger, preserving the concrete subclass. */
   protected derive(logger: Logger): this {
      return new DefaultTracer(logger, this.clock, this.readMemory) as this;
   }

   /** Hook for appending status-bracket suffixes like memory deltas. Default: none. */
   protected timingSuffix(_status: 'done' | 'failed' | 'cancelled', _elapsedMs: number, _options: TimeOptions): string {
      return '';
   }

   /** Hook to differentiate cancelled operations from failures. Default: all errors are failures. */
   protected categorizeError(_error: unknown): 'failed' | 'cancelled' {
      return 'failed';
   }
}
