/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { makeFakeClock } from '../../src/testing/fake-clock';

describe('makeFakeClock', () => {
   describe('now', () => {
      it('starts at 0 by default and follows advance', () => {
         const clock = makeFakeClock();
         expect(clock.now()).toBe(0);
         clock.advance(1000);
         expect(clock.now()).toBe(1000);
      });

      it('honours an explicit start instant', () => {
         const clock = makeFakeClock({ now: 5000 });
         expect(clock.now()).toBe(5000);
      });
   });

   describe('setTimer', () => {
      it('fires a timer once virtual time reaches its delay', () => {
         const clock = makeFakeClock();
         const fired = vi.fn();
         clock.setTimer(fired, 100);

         clock.advance(99);
         expect(fired).not.toHaveBeenCalled();
         clock.advance(1);
         expect(fired).toHaveBeenCalledTimes(1);
      });

      it('does not fire a disposed timer', () => {
         const clock = makeFakeClock();
         const fired = vi.fn();
         const timer = clock.setTimer(fired, 100);
         timer.dispose();

         clock.advance(200);
         expect(fired).not.toHaveBeenCalled();
      });

      it('sees the timer fire-instant via now() inside the callback', () => {
         const clock = makeFakeClock();
         let observed = -1;
         clock.setTimer(() => (observed = clock.now()), 100);

         clock.advance(250);
         expect(observed).toBe(100); // fired at its scheduled instant, not the advance target
         expect(clock.now()).toBe(250);
      });

      it('fires timers scheduled by an earlier callback within the same advance window', () => {
         const clock = makeFakeClock();
         const order: number[] = [];
         clock.setTimer(() => {
            order.push(clock.now());
            clock.setTimer(() => order.push(clock.now()), 50);
         }, 100);

         clock.advance(200);
         expect(order).toEqual([100, 150]);
      });

      it('fires multiple due timers in chronological order', () => {
         const clock = makeFakeClock();
         const order: string[] = [];
         clock.setTimer(() => order.push('late'), 200);
         clock.setTimer(() => order.push('early'), 50);

         clock.advance(300);
         expect(order).toEqual(['early', 'late']);
      });
   });

   describe('stopwatch', () => {
      it('reports elapsed against virtual time', () => {
         const clock = makeFakeClock();
         const sw = clock.stopwatch();
         clock.advance(750);
         expect(sw.elapsedMs).toBe(750);
      });

      it('lap returns the split since the previous lap and leaves the total running', () => {
         const clock = makeFakeClock();
         const sw = clock.stopwatch();

         clock.advance(100);
         expect(sw.lap()).toBe(100);
         clock.advance(250);
         expect(sw.lap()).toBe(250);
         expect(sw.elapsedMs).toBe(350); // total keeps running, not reset by lap
      });

      it('stop freezes and returns the grand total (sum of laps plus the tail)', () => {
         const clock = makeFakeClock();
         const sw = clock.stopwatch();

         clock.advance(100);
         const firstLap = sw.lap();
         clock.advance(60); // tail since the last lap
         const total = sw.stop();

         expect(firstLap).toBe(100);
         expect(total).toBe(160); // 100 lap + 60 tail
         clock.advance(1000);
         expect(sw.elapsedMs).toBe(160); // frozen — does not keep counting
      });

      it('stop is idempotent', () => {
         const clock = makeFakeClock();
         const sw = clock.stopwatch();
         clock.advance(100);
         expect(sw.stop()).toBe(100);
         clock.advance(50);
         expect(sw.stop()).toBe(100);
      });
   });
});
