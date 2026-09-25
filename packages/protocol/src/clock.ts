/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Disposable } from './util';

/**
 * Measures how long something takes. Born running at {@link Clock.stopwatch};
 * there is no `start` — you create it at the moment timing begins.
 *
 * Backed by a monotonic source (`performance.now`), so it is sub-millisecond
 * precise and immune to wall-clock jumps (NTP/DST adjustments can make a
 * `Date.now` delta go backwards; a stopwatch cannot). Use this for durations
 * and {@link Clock.now} for "what time is it" (timestamps, TTLs).
 *
 * It holds no scheduled resource and is therefore NOT a {@link Disposable} —
 * the disposable thing is a {@link Clock.setTimer}. Reads are lazy, so a fake
 * clock just answers the current virtual time.
 */
export interface Stopwatch {
   /** Total elapsed since creation; live while running, frozen after {@link stop}. */
   readonly elapsedMs: number;
   /**
    * Split: the elapsed since the previous `lap` (or since creation for the
    * first call), starting a new split. Non-destructive — the running total
    * ({@link elapsedMs}) is unaffected, so `lap` is not a restart.
    */
   lap(): number;
   /**
    * Freeze and return the grand total (the sum of every lap plus the tail
    * since the last lap). Idempotent: further calls return the same value and
    * {@link elapsedMs} stops advancing.
    */
   stop(): number;
}

/**
 * Injectable time, so logic gated on time (debounce windows, slow-update
 * warnings, request timeouts, the self-save TTL) is deterministically
 * testable instead of waiting on real wall-clock. The {@link SystemClock}
 * default delegates to the platform; tests bind `makeFakeClock`.
 *
 * Two distinct readings on purpose: {@link now} is wall-clock (for timestamps
 * and TTLs that compare against a file's mtime), while {@link stopwatch}
 * measures durations off a monotonic source. They are different clocks; do not
 * subtract two {@link now} readings to measure a duration.
 *
 * A cross-head contract, so it carries no platform or DI-framework coupling.
 *
 * Note: the runtime health monitors (event-loop, memory) intentionally keep
 * the real wall-clock rather than taking a `Clock` — faking the time they
 * measure would invert their meaning.
 */
export interface Clock {
   /** Current wall-clock time in milliseconds (the `Date.now` reading). */
   now(): number;
   /**
    * Run `callback` after `ms` have elapsed; the returned {@link Disposable}
    * cancels it if disposed before it fires. This is the testable
    * `setTimeout` — debounce, deferred slow-warn, request timeouts.
    */
   setTimer(callback: () => void, ms: number): Disposable;
   /** Start measuring a duration. See {@link Stopwatch}. */
   stopwatch(): Stopwatch;
   /**
    * Run `callback` and return its result together with how long it took.
    * Sugar over {@link stopwatch} — pure measurement, no logging and no
    * threshold gating (unlike `Tracer.time`). Use in
    * measurement pipelines that consume `elapsedMs` directly. Async callbacks
    * return a Promise of the same shape, timed across the full settle.
    */
   measure<T>(callback: () => Promise<T>): Promise<Timed<T>>;
   measure<T>(callback: () => T): Timed<T>;
   /**
    * Settle with `promise`, or with {@link TIMED_OUT} once `ms` have elapsed
    * first. A promise that rejects first rejects this one; one that rejects
    * after the timer is ignored. The timer is disposed the moment `promise`
    * settles, so a won race leaves nothing scheduled, but `promise` itself
    * runs on: nothing here can cancel it.
    *
    * Unlike VS Code's `raceTimeout`, this settles with a sentinel rather than
    * `undefined`, so a promise resolving to `undefined` is not taken for a
    * timeout; the caller branches on the result instead of passing an
    * `onTimeout`.
    *
    * A custom implementation extends {@link SystemClock}, whose race runs over
    * the subclass's {@link setTimer}.
    */
   raceTimer<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT>;
}

/**
 * What {@link Clock.raceTimer} settles with when its timer fires first.
 * Registered under a global key, so two copies of this package agree on it.
 */
export const TIMED_OUT = Symbol.for('hydranium/protocol/timed-out');

/**
 * The result of {@link Clock.measure}: a callback's return value paired with
 * its elapsed wall-time in milliseconds. A plain value object — no methods, no
 * logging — deliberately distinct from `@theia/core`'s `Measurement` (a
 * stateful self-logging handle), which would collide in a Theia process.
 */
export interface Timed<T> {
   /**
    * The callback's return value, unchanged. For an async callback this is the
    * settled value rather than the promise — and a callback that REJECTS
    * produces no `Timed` at all, because the rejection propagates, so a failed
    * run cannot be timed through this shape.
    */
   result: T;
   /**
    * Milliseconds off the monotonic source, so it is comparable with
    * {@link Stopwatch.elapsedMs} and NOT with a difference of two
    * {@link Clock.now} readings. For an async callback it spans the full settle,
    * not just the synchronous prefix.
    */
   elapsedMs: number;
}

class SystemStopwatch implements Stopwatch {
   protected readonly start = performance.now();
   protected lastLap = this.start;
   protected stopped: number | undefined;

   get elapsedMs(): number {
      return (this.stopped ?? performance.now()) - this.start;
   }

   lap(): number {
      const at = this.stopped ?? performance.now();
      const split = at - this.lastLap;
      this.lastLap = at;
      return split;
   }

   stop(): number {
      if (this.stopped === undefined) {
         this.stopped = performance.now();
      }
      return this.stopped - this.start;
   }
}

/**
 * Detach a timer from the event loop so a single pending timer never keeps a
 * Node process alive — a CLI run or test worker can exit cleanly while deferred
 * work (debounce, slow-warn, idle CST eviction) is still scheduled; the
 * persistent server connection keeps the loop alive in production regardless.
 *
 * `unref` is Node-only. {@link SystemClock} also runs in the browser, where
 * `setTimeout` returns a bare numeric handle with no `unref` — the optional
 * call is a no-op there, and declaring the parameter's `unref` optional accepts
 * a Node `NodeJS.Timeout` structurally without a cast.
 */
function unrefTimer(handle: { unref?: () => void }): void {
   handle.unref?.();
}

/**
 * Default {@link Clock}: delegates to the platform's `Date.now`,
 * `performance.now`, and `setTimeout`/`clearTimeout`. Bound everywhere in
 * production; swapped for `makeFakeClock` in tests.
 *
 * {@link measure} and {@link raceTimer} run over {@link stopwatch} and
 * {@link setTimer}, so a clock that extends this one and replaces those
 * measures and races on its own time, as the test clock does.
 */
export class SystemClock implements Clock {
   now(): number {
      return Date.now();
   }

   setTimer(callback: () => void, ms: number): Disposable {
      const handle = setTimeout(callback, ms);
      unrefTimer(handle);
      return Disposable.create(() => clearTimeout(handle));
   }

   stopwatch(): Stopwatch {
      return new SystemStopwatch();
   }

   measure<T>(callback: () => Promise<T>): Promise<Timed<T>>;
   measure<T>(callback: () => T): Timed<T>;
   measure<T>(callback: () => T | Promise<T>): Timed<T> | Promise<Timed<T>> {
      const stopwatch = this.stopwatch();
      const result = callback();
      if (result instanceof Promise) {
         return (result as Promise<T>).then(value => ({ result: value, elapsedMs: stopwatch.elapsedMs }));
      }
      return { result: result as T, elapsedMs: stopwatch.elapsedMs };
   }

   /**
    * The timer settles the race one microtask after it fires. A real timer
    * runs only once pending resolutions are delivered, while a fake one fires
    * inside its `advance`, so settling at once would let a promise already
    * resolved when `advance` runs lose to a timer it beats in production. The
    * deferral covers only that promise: one that settles through further
    * chained reactions, such as a `.then` chain, an async function or
    * `Promise.allSettled`, can still lose to an `advance` in the same turn,
    * while it wins on the platform's timer. The handlers go on `promise`
    * before {@link setTimer} runs, so a `setTimer` that throws still leaves
    * `promise` observed.
    */
   raceTimer<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
      return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
         // eslint-disable-next-line prefer-const -- with a `const`, a `setTimer` that throws leaves it uninitialised, and the handlers' later read of it is an unhandled ReferenceError
         let timer: Disposable | undefined;
         promise.then(
            value => {
               timer?.dispose();
               resolve(value);
            },
            (err: unknown) => {
               timer?.dispose();
               reject(err);
            }
         );
         timer = this.setTimer(() => void Promise.resolve().then(() => resolve(TIMED_OUT)), ms);
      });
   }
}
