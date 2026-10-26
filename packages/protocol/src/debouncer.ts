/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Stopwatch } from './clock';
import { ObservableValue, type MaybeObservableValue } from './observable-value';
import { type Disposable } from './util';

/** Construction options for {@link Debouncer}. */
export interface DebouncerOptions {
   /**
    * Trailing-edge delay in milliseconds, read per {@link Debouncer.schedule}
    * so a setting-bound cell reshapes the live window without rebuilding the
    * debouncer. A value `<= 0` still defers to the next tick via
    * {@link Clock.setTimer}; callers wanting a synchronous path handle that
    * themselves before scheduling.
    */
   readonly delayMs: MaybeObservableValue<number>;
   /**
    * Optional starvation ceiling. When calls keep arriving faster than
    * {@link delayMs}, the trailing edge never settles and `fn` would never
    * run; with `maxWaitMs` set, a fire is forced once that many milliseconds
    * have elapsed since the first pending {@link Debouncer.schedule}, so a
    * continuous stream still makes progress. Omitted (the default) = pure
    * trailing edge, which may defer indefinitely under a non-stop stream.
    */
   readonly maxWaitMs?: number;
}

/**
 * Trailing-edge debounce built on the injectable {@link Clock}, so the window
 * is deterministically testable with `makeFakeClock` — the framework's timer
 * seam rather than raw `setTimeout` (which `p-debounce` / `lodash.debounce`
 * hold internally and cannot be driven by a fake clock).
 *
 * Owns ONLY timing. {@link fn} is zero-argument and returns nothing: the caller
 * keeps whatever payload it is coalescing — an accumulator set, a "latest
 * value" field — and reads it inside `fn` when the debouncer fires. That
 * timing/payload split is what lets one primitive serve both an accumulating
 * caller (merge changed/deleted sets) and a replacing one (last value wins).
 *
 * Leading-edge invocation and a result-returning ("await the debounced run")
 * variant are deliberately omitted to keep this a pure timing primitive; both
 * are additive later (a `leading` option; a separate promise helper) rather
 * than a breaking change.
 */
export class Debouncer implements Disposable {
   /** {@link DebouncerOptions.delayMs}, read at each {@link schedule}. An armed timer keeps the delay it was armed with. */
   protected readonly delay: ObservableValue<number>;
   /** {@link DebouncerOptions.maxWaitMs}, fixed at construction unlike {@link delay}. */
   protected readonly maxWaitMs?: number;
   protected timer?: Disposable;
   /** Running since the first {@link schedule} of the current pending window; drives {@link DebouncerOptions.maxWaitMs}. */
   protected sinceFirstSchedule?: Stopwatch;

   constructor(
      protected readonly clock: Clock,
      protected readonly fn: () => void,
      options: DebouncerOptions
   ) {
      this.delay = ObservableValue.from(options.delayMs);
      this.maxWaitMs = options.maxWaitMs;
   }

   /** True while a fire is armed (scheduled, not yet fired or cancelled). */
   get pending(): boolean {
      return this.timer !== undefined;
   }

   /**
    * Arm — or re-arm — the trailing-edge timer. Repeated calls within the
    * window collapse into a single {@link fn} run at the trailing edge; with
    * {@link DebouncerOptions.maxWaitMs} set, the run is forced once that ceiling
    * elapses since the first pending call.
    */
   schedule(): void {
      this.sinceFirstSchedule ??= this.clock.stopwatch();
      let wait = Math.max(0, this.delay.value);
      if (this.maxWaitMs !== undefined) {
         const untilCeiling = this.maxWaitMs - this.sinceFirstSchedule.elapsedMs;
         wait = Math.min(wait, Math.max(0, untilCeiling));
      }
      this.timer?.dispose();
      this.timer = this.clock.setTimer(() => this.fire(), wait);
   }

   /** Run {@link fn} now if a fire is pending, clearing the window first, and do nothing otherwise. */
   flush(): void {
      if (this.timer !== undefined) {
         this.fire();
      }
   }

   /** Drop a pending fire without running {@link fn}. */
   cancel(): void {
      this.timer?.dispose();
      this.timer = undefined;
      this.sinceFirstSchedule = undefined;
   }

   /** Cancel any pending fire and release. */
   dispose(): void {
      this.cancel();
   }

   /** Clears the window before it runs {@link fn}, so a {@link schedule} from inside `fn` opens a new one. */
   protected fire(): void {
      this.timer?.dispose();
      this.timer = undefined;
      this.sinceFirstSchedule = undefined;
      this.fn();
   }
}
