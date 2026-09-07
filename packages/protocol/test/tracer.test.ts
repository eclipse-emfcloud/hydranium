/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbstractLogger } from '../src/abstract-logger';
import { Logger, type LogLevel } from '../src/logger';
import { DefaultTracer } from '../src/tracer';
import { makeFakeClock } from '../src/testing/fake-clock';

/** Logger double recording emitted lines (with component prefix), sharing one buffer across derivations. */
class CapturingLogger extends AbstractLogger {
   constructor(
      component: string | undefined,
      readonly lines: string[]
   ) {
      super(component);
   }
   protected emit(_level: LogLevel, _label: string, message: string): void {
      this.lines.push(`${this.component ? `[${this.component}] ` : ''}${message}`);
   }
   protected derive(component: string): this {
      return new CapturingLogger(component, this.lines) as this;
   }
}

function makeTracer(): { tracer: DefaultTracer; lines: string[]; clock: ReturnType<typeof makeFakeClock> } {
   const lines: string[] = [];
   const clock = makeFakeClock();
   return { tracer: new DefaultTracer(new CapturingLogger(undefined, lines), clock), lines, clock };
}

describe('DefaultTracer.time short-circuit', () => {
   afterEach(() => Logger.setLevel('info'));

   it('runs the callback and returns its result when the level is suppressed', () => {
      Logger.setLevel('off');
      const { tracer } = makeTracer();
      expect(tracer.time('op', () => 42, 'info')).toBe(42);
   });

   it('does not touch the clock when the level is suppressed', () => {
      Logger.setLevel('warn');
      const { tracer, lines, clock } = makeTracer();
      const stopwatchSpy = vi.spyOn(clock, 'stopwatch');
      const setTimerSpy = vi.spyOn(clock, 'setTimer');
      tracer.time('op', () => 'ok', 'info');
      expect(stopwatchSpy).not.toHaveBeenCalled();
      expect(setTimerSpy).not.toHaveBeenCalled();
      expect(lines).toHaveLength(0);
   });

   it('does not invoke options.captureId when the level is suppressed', () => {
      Logger.setLevel('off');
      const { tracer } = makeTracer();
      const captureId = vi.fn();
      tracer.time('op', () => undefined, 'info', { captureId });
      expect(captureId).not.toHaveBeenCalled();
   });

   it('propagates synchronous throws from the callback unchanged', () => {
      Logger.setLevel('off');
      const { tracer } = makeTracer();
      expect(() =>
         tracer.time(
            'op',
            () => {
               throw new Error('boom');
            },
            'info'
         )
      ).toThrow('boom');
   });

   it('propagates async rejection from the callback unchanged', async () => {
      Logger.setLevel('off');
      const { tracer } = makeTracer();
      await expect(tracer.time('op', () => Promise.reject(new Error('boom')), 'info')).rejects.toThrow('boom');
   });

   it('still measures and logs when the level is enabled', () => {
      Logger.setLevel('info');
      const { tracer, lines, clock } = makeTracer();
      const stopwatchSpy = vi.spyOn(clock, 'stopwatch');
      tracer.time('op', () => 'ok', 'info', { logAfterMs: 0 });
      expect(stopwatchSpy).toHaveBeenCalled();
      expect(lines.length).toBeGreaterThanOrEqual(1);
   });
});

describe('DefaultTracer.startTimer short-circuit', () => {
   afterEach(() => Logger.setLevel('info'));

   it('returns a no-op disposable when the level is suppressed', () => {
      Logger.setLevel('off');
      const { tracer, lines } = makeTracer();
      const handle = tracer.startTimer('op', 'info');
      expect(() => handle.dispose()).not.toThrow();
      expect(lines).toHaveLength(0);
   });

   it('does not touch the clock when the level is suppressed', () => {
      Logger.setLevel('warn');
      const { tracer, clock } = makeTracer();
      const stopwatchSpy = vi.spyOn(clock, 'stopwatch');
      tracer.startTimer('op', 'info').dispose();
      expect(stopwatchSpy).not.toHaveBeenCalled();
   });

   it('still schedules timing work when the level is enabled', () => {
      Logger.setLevel('info');
      const { tracer, clock } = makeTracer();
      const stopwatchSpy = vi.spyOn(clock, 'stopwatch');
      tracer.startTimer('op', 'info', 0).dispose();
      expect(stopwatchSpy).toHaveBeenCalled();
   });
});

describe('DefaultTracer.memory', () => {
   it('emits a formatted line when the reader returns memory info', () => {
      const lines: string[] = [];
      const tracer = new DefaultTracer(new CapturingLogger(undefined, lines), makeFakeClock(), () => ({
         usedBytes: 1024,
         totalBytes: 4096
      }));
      tracer.memory('Heap');
      expect(lines.some(line => line.includes('Heap') && line.includes('KB'))).toBe(true);
   });

   it('emits nothing when the reader returns undefined', () => {
      const lines: string[] = [];
      const tracer = new DefaultTracer(new CapturingLogger(undefined, lines), makeFakeClock(), () => undefined);
      tracer.memory();
      expect(lines).toHaveLength(0);
   });
});

describe('DefaultTracer derivation and profile', () => {
   afterEach(() => Logger.setLevel('info'));

   it('carries the component prefix into timed output via the derived logger', () => {
      Logger.setLevel('info');
      const { tracer, lines } = makeTracer();
      tracer.with('comp').time('op', () => 'ok', 'info', { logAfterMs: 0 });
      expect(lines.every(line => line.startsWith('[comp]'))).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(1);
   });

   it('opens a ProfileSession that records scoped self-time', () => {
      const { tracer, clock } = makeTracer();
      const session = tracer.profile('svc');
      session.scope('a', () => clock.advance(5));
      const [record] = session.records();
      expect(record.id).toBe('a');
      expect(record.selfMs).toBe(5);
   });
});
