/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { Debouncer } from '../src/debouncer';
import { type ObservableValue } from '../src/observable-value';
import { Disposable } from '../src/util';
import { makeFakeClock } from '../src/testing/fake-clock';

describe('Debouncer', () => {
   describe('trailing edge', () => {
      it('fires fn once the delay elapses after a schedule', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.schedule();
         clock.advance(99);
         expect(fn).not.toHaveBeenCalled();
         clock.advance(1);
         expect(fn).toHaveBeenCalledTimes(1);
      });

      it('collapses a burst into a single trailing fire (timer resets per call)', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.schedule();
         clock.advance(60);
         debouncer.schedule(); // resets the window
         clock.advance(60); // 120 total, but only 60 since the last schedule
         expect(fn).not.toHaveBeenCalled();
         clock.advance(40); // 100 since the last schedule
         expect(fn).toHaveBeenCalledTimes(1);
      });

      it('reads the latest payload inside fn (timing/payload split)', () => {
         const clock = makeFakeClock();
         let latest = 0;
         const seen: number[] = [];
         const debouncer = new Debouncer(clock, () => seen.push(latest), { delayMs: 100 });

         latest = 1;
         debouncer.schedule();
         latest = 2;
         debouncer.schedule();
         clock.advance(100);
         expect(seen).toEqual([2]); // last value wins; one fire
      });
   });

   describe('pending', () => {
      it('is true between schedule and fire, false after', () => {
         const clock = makeFakeClock();
         const debouncer = new Debouncer(clock, vi.fn(), { delayMs: 100 });

         expect(debouncer.pending).toBe(false);
         debouncer.schedule();
         expect(debouncer.pending).toBe(true);
         clock.advance(100);
         expect(debouncer.pending).toBe(false);
      });
   });

   describe('cancel', () => {
      it('drops a pending fire without running fn', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.schedule();
         debouncer.cancel();
         clock.advance(1000);
         expect(fn).not.toHaveBeenCalled();
         expect(debouncer.pending).toBe(false);
      });
   });

   describe('flush', () => {
      it('runs fn immediately when a fire is pending', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.schedule();
         debouncer.flush();
         expect(fn).toHaveBeenCalledTimes(1);
         expect(debouncer.pending).toBe(false);
         // The original trailing timer must not also fire.
         clock.advance(1000);
         expect(fn).toHaveBeenCalledTimes(1);
      });

      it('is a no-op when nothing is pending', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.flush();
         expect(fn).not.toHaveBeenCalled();
      });
   });

   describe('dispose', () => {
      it('cancels a pending fire', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100 });

         debouncer.schedule();
         debouncer.dispose();
         clock.advance(1000);
         expect(fn).not.toHaveBeenCalled();
      });
   });

   describe('maxWaitMs', () => {
      it('forces a fire once the ceiling elapses under a non-stop stream', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100, maxWaitMs: 250 });

         // Re-schedule every 50ms so the 100ms trailing edge never settles.
         debouncer.schedule(); // window opens at t=0
         clock.advance(50);
         debouncer.schedule();
         clock.advance(50); // t=100
         debouncer.schedule();
         clock.advance(50); // t=150
         debouncer.schedule();
         clock.advance(50); // t=200
         expect(fn).not.toHaveBeenCalled();
         debouncer.schedule(); // at t=200, ceiling (t=250) is 50ms away → wait clamps to 50
         clock.advance(50); // t=250 → forced fire
         expect(fn).toHaveBeenCalledTimes(1);
      });

      it('opens a fresh ceiling window after firing', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         const debouncer = new Debouncer(clock, fn, { delayMs: 100, maxWaitMs: 250 });

         debouncer.schedule();
         clock.advance(100); // trailing fire
         expect(fn).toHaveBeenCalledTimes(1);

         // Second window: the ceiling is measured from here, not the first schedule.
         debouncer.schedule();
         clock.advance(100);
         expect(fn).toHaveBeenCalledTimes(2);
      });
   });

   describe('observable delay', () => {
      it('reads the live delay value per schedule', () => {
         const clock = makeFakeClock();
         const fn = vi.fn();
         let delay = 100;
         const cell: ObservableValue<number> = { value: 0, onChange: () => Disposable.EMPTY };
         Object.defineProperty(cell, 'value', { get: () => delay });
         const debouncer = new Debouncer(clock, fn, { delayMs: cell });

         debouncer.schedule();
         clock.advance(100);
         expect(fn).toHaveBeenCalledTimes(1);

         delay = 50;
         debouncer.schedule();
         clock.advance(49);
         expect(fn).toHaveBeenCalledTimes(1);
         clock.advance(1);
         expect(fn).toHaveBeenCalledTimes(2);
      });
   });
});
