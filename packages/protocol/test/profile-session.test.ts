/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultProfileSession } from '../src/profile-session';
import { Logger, type LogLevel } from '../src/logger';
import { NoopLogger } from '../src/noop-logger';
import { makeFakeClock } from '../src/testing/fake-clock';

/** Logger double that captures the messages `report()` emits, for assertions. */
class CapturingLogger extends NoopLogger {
   readonly lines: string[] = [];
   protected override emit(_level: LogLevel, _label: string, message: string): void {
      this.lines.push(message);
   }
}

describe('DefaultProfileSession aggregation', () => {
   it('aggregates repeated scopes of the same id into count + summed self-time', () => {
      const clock = makeFakeClock();
      const session = new DefaultProfileSession(new NoopLogger(), clock, 'svc');
      session.scope('a', () => clock.advance(10));
      session.scope('b', () => clock.advance(4));
      session.scope('a', () => clock.advance(6));

      const byId = Object.fromEntries(session.records().map(record => [record.id, record]));
      expect(byId.a.count).toBe(2);
      expect(byId.a.selfMs).toBe(16);
      expect(byId.b.count).toBe(1);
      expect(byId.b.selfMs).toBe(4);
   });

   it('excludes nested scope time from the parent self-time (parent-exclusive)', () => {
      const clock = makeFakeClock();
      const session = new DefaultProfileSession(new NoopLogger(), clock, 'svc');
      session.scope('outer', () => {
         clock.advance(2);
         session.scope('inner', () => clock.advance(8));
         clock.advance(1);
      });

      const byId = Object.fromEntries(session.records().map(record => [record.id, record]));
      expect(byId.outer.selfMs).toBe(3); // 11ms wall minus the 8ms inner
      expect(byId.inner.selfMs).toBe(8);
   });

   it('computes self-% against the session total wall-clock', () => {
      const clock = makeFakeClock();
      const session = new DefaultProfileSession(new NoopLogger(), clock, 'svc');
      session.scope('a', () => clock.advance(10));
      session.scope('b', () => clock.advance(30));

      const byId = Object.fromEntries(session.records().map(record => [record.id, record]));
      expect(byId.a.selfPct).toBeCloseTo(25);
      expect(byId.b.selfPct).toBeCloseTo(75);
   });

   it('awaits an async scope so timing covers the full settle', async () => {
      const clock = makeFakeClock();
      const session = new DefaultProfileSession(new NoopLogger(), clock, 'svc');
      await session.scope('async', async () => {
         clock.advance(7);
      });

      const [record] = session.records();
      expect(record.id).toBe('async');
      expect(record.selfMs).toBe(7);
   });

   it('records the elapsed time of a throwing scope and rethrows', () => {
      const clock = makeFakeClock();
      const session = new DefaultProfileSession(new NoopLogger(), clock, 'svc');
      expect(() =>
         session.scope('x', () => {
            clock.advance(5);
            throw new Error('boom');
         })
      ).toThrow('boom');

      const [record] = session.records();
      expect(record.id).toBe('x');
      expect(record.selfMs).toBe(5);
   });
});

describe('DefaultProfileSession report', () => {
   afterEach(() => Logger.setLevel('info'));

   it('emits one line per id sorted by self-time descending', () => {
      const clock = makeFakeClock();
      const logger = new CapturingLogger();
      const session = new DefaultProfileSession(logger, clock, 'svc');
      session.scope('small', () => clock.advance(10));
      session.scope('big', () => clock.advance(30));
      session.report('info');

      const bigLine = logger.lines.findIndex(line => line.includes('big'));
      const smallLine = logger.lines.findIndex(line => line.includes('small'));
      expect(bigLine).toBeGreaterThanOrEqual(0);
      expect(smallLine).toBeGreaterThan(bigLine);
   });

   it('is a no-op when the report level is suppressed', () => {
      const clock = makeFakeClock();
      const logger = new CapturingLogger();
      const session = new DefaultProfileSession(logger, clock, 'svc');
      session.scope('a', () => clock.advance(10));
      const recordsSpy = vi.spyOn(session, 'records');
      Logger.setLevel('off');

      session.report('info');

      // The WORK the guard avoids, not the output. `AbstractLogger.send` already
      // drops a below-threshold line, so an empty `lines` is produced whether or
      // not the guard ran — it cannot witness the aggregation (a per-id reduce, a
      // sort, and a template string per record) the guard exists to skip.
      expect(recordsSpy).not.toHaveBeenCalled();
      expect(logger.lines).toHaveLength(0);
   });
});
