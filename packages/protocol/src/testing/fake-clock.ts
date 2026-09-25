/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Stopwatch, SystemClock } from '../clock';
import { Disposable } from '../util';

/** A {@link Clock} whose time only moves when the test calls {@link FakeClock.advance}. */
export interface FakeClock extends Clock {
   /**
    * Move virtual time forward by `ms`, firing every {@link Clock.setTimer}
    * whose deadline falls within the window — in chronological order, each at
    * its own deadline (so `now()` inside a callback reads the fire instant, not
    * the advance target). Timers scheduled by a callback fire too if they fall
    * within the same window. A {@link Clock.raceTimer} over a promise that
    * settles through a chain still pending loses to the timer, so let that
    * chain settle before advancing.
    */
   advance(ms: number): void;
   /** How many {@link Clock.setTimer} timers have neither fired nor been disposed. */
   pendingTimers(): number;
}

interface FakeTimer {
   readonly at: number;
   readonly callback: () => void;
   disposed: boolean;
   fired: boolean;
}

/**
 * In-process {@link Clock} double for deterministic time. The real
 * `SystemClock` has two underlying sources
 * (`Date.now` for `now()`, `performance.now()` for the stopwatch); the fake
 * collapses them onto ONE virtual time axis, so a single
 * {@link FakeClock.advance} drives `now()`, every live stopwatch's elapsed, and
 * any due timer together.
 *
 * Server-free and DI-free — lives in `@hydranium/protocol/testing` so every
 * head can bind it without pulling in a server package.
 *
 * The clock is a `SystemClock` with its time replaced, so its methods live on
 * its prototype and a spread of it carries none of them. Replace one by
 * assigning it onto the clock, or layer over the clock with `Object.create`.
 */
export function makeFakeClock(options: { now?: number } = {}): FakeClock {
   return new VirtualClock(options.now ?? 0);
}

/**
 * A `SystemClock` whose time, stopwatches and timers read one virtual axis, so
 * the `measure` and `raceTimer` it inherits run on that axis too.
 */
class VirtualClock extends SystemClock implements FakeClock {
   protected readonly timers: FakeTimer[] = [];

   constructor(protected current: number) {
      super();
   }

   override now(): number {
      return this.current;
   }

   override setTimer(callback: () => void, ms: number): Disposable {
      const timer: FakeTimer = { at: this.current + ms, callback, disposed: false, fired: false };
      this.timers.push(timer);
      return Disposable.create(() => {
         timer.disposed = true;
      });
   }

   override stopwatch(): Stopwatch {
      const read = (): number => this.current;
      const start = read();
      let lastLap = start;
      let stopped: number | undefined;
      return {
         get elapsedMs(): number {
            return (stopped ?? read()) - start;
         },
         lap(): number {
            const at = stopped ?? read();
            const split = at - lastLap;
            lastLap = at;
            return split;
         },
         stop(): number {
            stopped ??= read();
            return stopped - start;
         }
      };
   }

   pendingTimers(): number {
      return this.timers.filter(timer => !timer.disposed && !timer.fired).length;
   }

   advance(ms: number): void {
      const target = this.current + ms;
      // Fire due timers one at a time, re-scanning after each so a callback
      // that schedules a nearer timer still fires within this window.
      for (;;) {
         const next = this.timers
            .filter(timer => !timer.disposed && !timer.fired && timer.at <= target)
            .sort((left, right) => left.at - right.at)[0];
         if (!next) {
            break;
         }
         this.current = next.at;
         next.fired = true;
         next.callback();
      }
      this.current = target;
   }
}
