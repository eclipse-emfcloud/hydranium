/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Stopwatch, type Timed } from '../clock';
import { Disposable } from '../util';

/** A {@link Clock} whose time only moves when the test calls {@link FakeClock.advance}. */
export interface FakeClock extends Clock {
   /**
    * Move virtual time forward by `ms`, firing every {@link Clock.setTimer}
    * whose deadline falls within the window — in chronological order, each at
    * its own deadline (so `now()` inside a callback reads the fire instant, not
    * the advance target). Timers scheduled by a callback fire too if they fall
    * within the same window.
    */
   advance(ms: number): void;
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
 */
export function makeFakeClock(options: { now?: number } = {}): FakeClock {
   let current = options.now ?? 0;
   const timers: FakeTimer[] = [];

   const makeStopwatch = (): Stopwatch => {
      const start = current;
      let lastLap = current;
      let stopped: number | undefined;
      return {
         get elapsedMs(): number {
            return (stopped ?? current) - start;
         },
         lap(): number {
            const at = stopped ?? current;
            const split = at - lastLap;
            lastLap = at;
            return split;
         },
         stop(): number {
            if (stopped === undefined) {
               stopped = current;
            }
            return stopped - start;
         }
      };
   };

   return {
      now: () => current,
      setTimer(callback: () => void, ms: number): Disposable {
         const timer: FakeTimer = { at: current + ms, callback, disposed: false, fired: false };
         timers.push(timer);
         return Disposable.create(() => {
            timer.disposed = true;
         });
      },
      stopwatch: makeStopwatch,
      measure: (<T>(callback: () => T | Promise<T>): Timed<T> | Promise<Timed<T>> => {
         const stopwatch = makeStopwatch();
         const result = callback();
         if (result instanceof Promise) {
            return (result as Promise<T>).then(value => ({ result: value, elapsedMs: stopwatch.elapsedMs }));
         }
         return { result: result as T, elapsedMs: stopwatch.elapsedMs };
      }) as Clock['measure'],
      advance(ms: number): void {
         const target = current + ms;
         // Fire due timers one at a time, re-scanning after each so a callback
         // that schedules a nearer timer still fires within this window.
         for (;;) {
            const next = timers
               .filter(timer => !timer.disposed && !timer.fired && timer.at <= target)
               .sort((left, right) => left.at - right.at)[0];
            if (!next) {
               break;
            }
            current = next.at;
            next.fired = true;
            next.callback();
         }
         current = target;
      }
   };
}
