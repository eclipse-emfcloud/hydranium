/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../src/clock';

/**
 * Feed the stopwatch a scripted monotonic source, one reading per
 * `performance.now()` call, so the split/total algebra is asserted against
 * exact numbers instead of whatever wall-time the run happens to take.
 *
 * The production stopwatch reads the global directly, which is what makes the
 * spy necessary: without it the only discriminating assertions about splits
 * live against `makeFakeClock`, a SECOND implementation of the same algebra,
 * and this class is covered by inequalities a monotonic clock satisfies by
 * construction. The last reading repeats if a test asks for more.
 */
function scriptMonotonicClock(readings: readonly number[]): void {
   let index = 0;
   vi.spyOn(performance, 'now').mockImplementation(() => readings[Math.min(index++, readings.length - 1)]);
}

afterEach(() => {
   vi.restoreAllMocks();
});

/**
 * `SystemClock` is a thin wrapper over the platform's `Date.now` /
 * `performance.now` / `setTimeout`. The wiring is pinned against the real
 * platform; the stopwatch algebra — splits, the running total, the frozen
 * reading after `stop` — is pinned against a scripted `performance.now`, so
 * these assertions cover the shipped class rather than restating a property
 * every monotonic clock already has.
 */
describe('SystemClock', () => {
   it('now() returns a wall-clock millisecond reading', () => {
      const clock = new SystemClock();
      const before = Date.now();
      const now = clock.now();
      expect(now).toBeGreaterThanOrEqual(before);
   });

   it('setTimer returns a Disposable', () => {
      const clock = new SystemClock();
      const timer = clock.setTimer(() => undefined, 10_000);
      expect(typeof timer.dispose).toBe('function');
      timer.dispose(); // cancels the pending timer so the test process stays clean
   });

   it('elapsedMs is the live monotonic reading minus the creation reading', () => {
      scriptMonotonicClock([1000, 1005, 1020]);
      const sw = new SystemClock().stopwatch();
      expect(sw.elapsedMs).toBe(5);
      expect(sw.elapsedMs).toBe(20);
   });

   it('stop freezes elapsed and is idempotent', () => {
      const clock = new SystemClock();
      const sw = clock.stopwatch();
      const total = sw.stop();
      expect(sw.stop()).toBe(total); // idempotent
      expect(sw.elapsedMs).toBe(total); // frozen — no further counting
   });

   it('lap returns the split since the previous lap and leaves the running total alone', () => {
      scriptMonotonicClock([1000, 1010, 1035, 1060]);
      const sw = new SystemClock().stopwatch();
      expect(sw.lap()).toBe(10);
      // 25, not the 35 a cumulative `reading - start` would produce: `lap` is a
      // split, not a restart, and the doc's promise is exactly this difference.
      expect(sw.lap()).toBe(25);
      // Non-destructive: the two laps did not reset or advance the total.
      expect(sw.elapsedMs).toBe(60);
   });

   it('lap after stop splits against the frozen reading, not the live clock', () => {
      scriptMonotonicClock([1000, 1040, 1999]);
      const sw = new SystemClock().stopwatch();
      expect(sw.stop()).toBe(40);
      expect(sw.lap()).toBe(40); // the 1999 reading is never taken — `stopped` wins
   });

   /**
    * `measure` is the API every production timing site calls, and each of those
    * sites is reached in tests only through a fake clock whose `measure` is a
    * second implementation of the same algebra. So the shipped one is asserted
    * here against the scripted monotonic source, on an exact number: an
    * inequality, or a `Timed` whose `elapsedMs` were a constant, is satisfied by
    * a measure that never reads the clock at all.
    */
   describe('measure', () => {
      it('pairs a sync callback result with the elapsed span across the call', () => {
         scriptMonotonicClock([1000, 1042]);
         const timed = new SystemClock().measure(() => 'value');
         expect(timed).toEqual({ result: 'value', elapsedMs: 42 });
      });

      it('returns the sync result synchronously, not as a promise', () => {
         scriptMonotonicClock([1000, 1042]);
         // The overload contract: a sync callback must not force its caller to
         // await, which is what lets a timing site stay on its own call stack.
         expect(new SystemClock().measure(() => 1)).not.toBeInstanceOf(Promise);
      });

      it('awaits an async callback and measures to its RESOLUTION, not to its call', async () => {
         scriptMonotonicClock([1000, 1050, 1099]);
         const pending = new SystemClock().measure(async () => {
            await Promise.resolve();
            // Consumes the second scripted reading, so the source has ADVANCED
            // between the synchronous return and the resolution. Without a
            // reading in flight both a `then`-time sample and a return-time one
            // report the same number and the assertion pins nothing.
            performance.now();
            return 'value';
         });

         await expect(pending).resolves.toEqual({ result: 'value', elapsedMs: 99 });
      });
   });
});
