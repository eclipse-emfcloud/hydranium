/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The four observability doubles, measured against the real `NoopLogger` /
 * `DefaultTracer` they are documented as being equivalent to.
 *
 * These have no interface to conform to — they are factories returning real
 * framework classes — so a compiler sees nothing here. What it cannot see is
 * the three properties every consumer of `makeCapturingLogger` silently
 * depends on, and which no suite asserting on its OWN subject would notice
 * losing:
 *
 * - **Derived children share the sink.** A service under test almost always
 *   logs through `tracer.for(name)` rather than the instance it was handed, so
 *   a derivation that broke the sink would empty every capture array in the
 *   repo while every individual test still read as "the code did not log".
 * - **Emission stays threshold-gated.** The process-wide threshold is `'info'`
 *   by default, so a test asserting on a `debug`/`trace` line captures nothing
 *   until it raises the level. A capture helper that bypassed the gate would
 *   make those tests pass for the wrong reason.
 * - **The tracer runs on the clock it was given.** Timing lines are the only
 *   reason to reach for `makeCapturingTracer` over `makeCapturingLogger`, and
 *   a tracer that ignored the injected clock would report real elapsed time
 *   against a fake-time fixture — asserted against the `SystemClock` default,
 *   which reports nothing at all on a synchronous callback.
 *
 * `Logger.setLevel` is PROCESS-WIDE, so the level is saved and restored around
 * every test rather than left where a gating assertion put it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultTracer, Logger, NoopLogger, SystemClock, type LogThreshold } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { makeCapturingLogger, makeCapturingTracer, makeNoopLogger, makeNoopTracer, type CapturedLine } from '../../src/testing/index.js';

let entryLevel: LogThreshold;

beforeEach(() => {
   entryLevel = Logger.getLevel();
   Logger.setLevel('info');
});

afterEach(() => {
   Logger.setLevel(entryLevel);
});

/**
 * Captured messages with the timer id normalised out — the id comes from a
 * module-global counter shared by every timed span in the file, so pinning it
 * would couple each assertion to the order of the ones before it.
 */
function messages(lines: readonly CapturedLine[]): string[] {
   return lines.map(line => line.message.replace(/#\d+/, '#N'));
}

describe('makeNoopTracer / makeNoopLogger — equivalence to the classes they name', () => {
   it('returns a DefaultTracer over a NoopLogger and a SystemClock', () => {
      const tracer = makeNoopTracer();
      const composed = tracer as unknown as { logger: unknown; clock: unknown };

      expect(tracer).toBeInstanceOf(DefaultTracer);
      expect(composed.logger).toBeInstanceOf(NoopLogger);
      expect(composed.clock).toBeInstanceOf(SystemClock);
   });

   it('returns a NoopLogger whose fluent surface stays usable', () => {
      const logger = makeNoopLogger();

      expect(logger).toBeInstanceOf(NoopLogger);
      // `for` / `sub` / `with` derive a fresh no-op instance; `withUri` is
      // overridden on `NoopLogger` to short-circuit to the SAME instance,
      // because composing a label nothing will render is wasted work.
      expect(logger.for('One')).not.toBe(logger);
      expect(logger.sub('One')).not.toBe(logger);
      expect(logger.with('One')).not.toBe(logger);
      expect(logger.withUri('file:///a.x')).toBe(logger);
      expect(logger.for('One')).toBeInstanceOf(NoopLogger);
   });
});

describe('makeCapturingLogger — the sink', () => {
   it('captures a line through the instance it returned', () => {
      const { logger, lines } = makeCapturingLogger();
      logger.info('direct');

      expect(lines).toEqual([{ level: 'info', message: 'direct' }]);
   });

   it('captures lines emitted through every derived child, in order, on the one sink', () => {
      const { logger, lines } = makeCapturingLogger();

      logger.for('One').info('from-for');
      logger.sub('Two').info('from-sub');
      logger.with('Three').info('from-with');
      logger.withUri('file:///a.x').info('from-with-uri');
      logger.for('One').sub('Two').with('Three').info('from-chain');

      // ABSOLUTE list, not a length: a child writing to its own array would
      // leave the parent's sink holding only `from-with-uri` (which shares the
      // instance) and a length assertion set to 5 would be the only tell.
      expect(messages(lines)).toEqual(['from-for', 'from-sub', 'from-with', 'from-with-uri', 'from-chain']);
   });

   it('records the level and the message, not the interpolation arguments', () => {
      const { logger, lines } = makeCapturingLogger();
      logger.error('failed', { detail: 1 });
      logger.warn('careful');
      logger.log('logged');

      expect(lines).toEqual([
         { level: 'error', message: 'failed' },
         { level: 'warn', message: 'careful' },
         // `log` is info-level with a different LABEL, and the label is not
         // part of a captured line.
         { level: 'info', message: 'logged' }
      ]);
   });
});

describe('makeCapturingLogger — the process-wide threshold gate', () => {
   it('drops a line below the active threshold and captures it once the level is raised', () => {
      const { logger, lines } = makeCapturingLogger();

      logger.info('at-info');
      logger.debug('at-debug');
      logger.trace('at-trace');
      expect(messages(lines)).toEqual(['at-info']);

      Logger.setLevel('trace');
      logger.debug('at-debug');
      logger.trace('at-trace');
      expect(messages(lines)).toEqual(['at-info', 'at-debug', 'at-trace']);
   });

   it('gates a derived child on the same threshold as its parent', () => {
      const { logger, lines } = makeCapturingLogger();

      logger.for('One').debug('dropped');
      expect(lines).toEqual([]);

      Logger.setLevel('debug');
      logger.for('One').debug('kept');
      expect(messages(lines)).toEqual(['kept']);
   });
});

describe('makeCapturingTracer — the clock axis', () => {
   it('reports elapsed time from the clock it was given, not from wall time', () => {
      const clock = makeFakeClock();
      const { tracer, lines } = makeCapturingTracer(clock);

      const result = tracer.time('probe', () => {
         clock.advance(250);
         return 'value';
      });

      expect(result).toBe('value');
      // Fake time drives both halves of a timed span: the deferred start line
      // fires because the 5ms deadline fell inside the window, and the done
      // line carries the advanced elapsed.
      expect(messages(lines)).toEqual(['probe [#N start]', 'probe [#N done, 250ms]']);
   });

   it('defaults to a SystemClock, on which the same synchronous span reports nothing', () => {
      const { tracer, lines } = makeCapturingTracer();

      tracer.time('probe', () => 'value');

      // The anchor for the test above: on real time a synchronous callback
      // finishes before the deferred start deadline, so the span is suppressed
      // entirely. Identical output on both clocks would mean the injected clock
      // reached nothing.
      expect(lines).toEqual([]);
   });

   it('captures plain emissions on the same sink as its timing lines, derived children included', () => {
      const clock = makeFakeClock();
      const { tracer, lines } = makeCapturingTracer(clock);

      tracer.for('One').info('plain');
      tracer.time('probe', () => clock.advance(10));

      expect(messages(lines)).toEqual(['plain', 'probe [#N start]', 'probe [#N done, 10ms]']);
   });
});
