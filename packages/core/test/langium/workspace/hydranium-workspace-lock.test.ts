/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultWorkspaceLock, type MaybePromise, OperationCancelled, ReadPriority } from '@hydranium/langium';
import { Deferred, SystemClock } from '@hydranium/protocol';
import { makeFakeClock, tick } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { HydraniumWorkspaceLock } from '../../../src/langium/workspace/hydranium-workspace-lock.js';
import { releaseReadHolds } from '../../../src/langium/workspace/lock-scope.js';
import { makeCapturingTracer } from '../../../src/testing/index.js';

const WARN_MS = 1_000;
const LIMIT_MS = 5_000;

function makeLock(stalledWriteWarnMs = WARN_MS) {
   const clock = makeFakeClock();
   const { tracer, lines } = makeCapturingTracer(clock);
   const lock = new HydraniumWorkspaceLock({ Clock: clock, Tracer: tracer }, { stalledWriteWarnMs, readHoldLimitMs: LIMIT_MS });
   const warnings = (): string[] => lines.filter(line => line.level === 'warn').map(line => line.message);
   return { lock, clock, warnings };
}

/** Start a write on `lock` that runs until `release` is called. */
async function holdWrite(lock: HydraniumWorkspaceLock): Promise<{ release(): void; held: Promise<void> }> {
   let release!: () => void;
   let started!: () => void;
   const running = new Promise<void>(resolve => (started = resolve));
   const held = lock.write(() => {
      started();
      return new Promise<void>(resolve => (release = resolve));
   });
   await running;
   return { release, held };
}

describe('HydraniumWorkspaceLock stalled-write diagnosis', () => {
   it('logs one warning for a write still running the configured time after it was cancelled', async () => {
      const { lock, clock, warnings } = makeLock();
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS - 1);
      expect(warnings()).toEqual([]);
      clock.advance(1);
      expect(warnings()).toEqual([expect.stringContaining('still running 1000 ms after it was cancelled')]);
      clock.advance(WARN_MS * 5);
      expect(warnings()).toHaveLength(1);

      release();
      await Promise.all([held, queued]);
   });

   it('logs nothing for a cancelled write that ends in time', async () => {
      const { lock, clock, warnings } = makeLock();
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      release();
      await Promise.all([held, queued]);
      clock.advance(WARN_MS * 2);
      expect(warnings()).toEqual([]);
      expect(clock.pendingTimers()).toBe(0);
   });

   it('times only the read-hold limit when the check is off', async () => {
      const { lock, clock, warnings } = makeLock(0);
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS * 2);
      expect(warnings()).toEqual([]);
      expect(clock.pendingTimers()).toBe(1);

      release();
      await Promise.all([held, queued]);
   });

   it('diagnoses a write that waits for a write queued behind it', async () => {
      // The shape a model-service call from inside a build takes where no tracker
      // can reject it: the inner write waits for the outer to end, and the outer
      // waits for the inner, so neither settles.
      const { lock, clock, warnings } = makeLock();
      let innerSettled = false;
      void lock.write(async () => {
         await lock.write(() => undefined);
         innerSettled = true;
      });
      await tick();

      clock.advance(WARN_MS);
      expect(innerSettled).toBe(false);
      expect(warnings()).toEqual([expect.stringContaining('from inside a build')]);
   });

   it('logs one warning for a write that waits the configured time behind a read', async () => {
      const { lock, clock, warnings } = makeLock();
      const read = holdRead(lock);
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();

      clock.advance(WARN_MS - 1);
      expect(warnings()).toEqual([]);
      clock.advance(1);
      expect({ ran, warnings: warnings() }).toEqual({
         ran: false,
         warnings: [expect.stringContaining('waited 1000 ms to start behind reads')]
      });

      read.release();
      await Promise.all([read.held, queued]);
      expect(clock.pendingTimers()).toBe(0);
   });

   it('logs one warning for a write queued while a queued read waits for the limit', async () => {
      const { lock, clock, warnings } = makeLock();
      const reading = lock.read(() => lock.read(() => undefined));
      await tick();
      const queued = lock.write(() => undefined);
      await tick();

      clock.advance(WARN_MS);
      expect(warnings()).toEqual([expect.stringContaining('waited 1000 ms to start behind reads')]);

      clock.advance(LIMIT_MS);
      await Promise.all([reading, queued]);
   });

   it('times a write behind a running write from when that write ends', async () => {
      const { lock, clock, warnings } = makeLock(WARN_MS);
      const { release, held } = await holdWrite(lock);
      // Arrives during the running write, so the next write waits for it.
      const read = holdRead(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS - 1);
      release();
      await held;
      clock.advance(WARN_MS - 1);
      expect(warnings()).toEqual([]);
      clock.advance(1);
      expect(warnings()).toEqual([expect.stringContaining('to start behind reads')]);

      read.release();
      await queued;
   });
});

/** Start an immediate read on `lock`, as Langium runs an LSP request, that runs until `release` is called. */
function holdRead(lock: HydraniumWorkspaceLock): { release(): void; held: Promise<void> } {
   const gate = new Deferred();
   return { release: () => gate.resolve(), held: lock.read(() => gate.promise, ReadPriority.Immediate) };
}

describe('HydraniumWorkspaceLock read-hold limit', () => {
   it('starts a write that reads held off for the limit beside them, and warns', async () => {
      const { lock, clock, warnings } = makeLock(0);
      const read = holdRead(lock);
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();

      clock.advance(LIMIT_MS - 1);
      await tick();
      const ranBeforeLimit = ran;
      clock.advance(1);
      await queued;

      expect({ ranBeforeLimit, ran, warnings: warnings() }).toEqual({
         ranBeforeLimit: false,
         ran: true,
         warnings: [expect.stringContaining('waited 5000 ms for 1 read(s), and now starts beside them')]
      });
      read.release();
      await read.held;
   });

   it('ends a read that awaits a write it queued, in a host without a read-lock tracker', async () => {
      const { lock, clock } = makeLock(0);
      const reading = lock.read(async () => {
         await lock.write(() => undefined);
         return 'written';
      }, ReadPriority.Immediate);
      await tick();

      clock.advance(LIMIT_MS);

      await expect(reading).resolves.toBe('written');
   });

   it('starts a build a read requests beside every running read, in a host without a read-lock tracker', async () => {
      const { lock } = makeLock(0);
      const other = holdRead(lock);
      const building = lock.read(async () => {
         await releaseReadHolds(lock, () => lock.write(() => undefined));
         return 'built';
      }, ReadPriority.Immediate);

      await expect(building).resolves.toBe('built');
      other.release();
      await other.held;
   });

   it('ends a read that awaits the work of another read, which waits for a write', async () => {
      const { lock, clock } = makeLock(0);
      const first = lock.read(async () => {
         await lock.write(() => undefined);
         return 'first';
      }, ReadPriority.Immediate);
      const second = lock.read(() => first, ReadPriority.Immediate);
      await tick();

      clock.advance(LIMIT_MS);

      await expect(second).resolves.toBe('first');
   });

   it('starts a write that reads arriving after the limit hold off, once the limit passes again', async () => {
      const { lock, clock } = makeLock(0);
      const first = holdRead(lock);
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();
      clock.advance(LIMIT_MS);
      // Arrives before Langium checks again, so the write waits for it too.
      const later = holdRead(lock);
      await tick();
      const ranAfterOneLimit = ran;

      clock.advance(LIMIT_MS);
      await queued;

      expect({ ranAfterOneLimit, ran }).toEqual({ ranAfterOneLimit: false, ran: true });
      first.release();
      later.release();
      await Promise.all([first.held, later.held]);
   });

   it('ends a queued read that awaits a queued read it starts, after the limit, and warns', async () => {
      // The shape of a request with no required state that awaits a recovery
      // build, whose own queued read waits for the batch the request runs in.
      const { lock, clock, warnings } = makeLock(0);
      let ended = false;
      const reading = lock.read(async () => {
         await lock.read(() => undefined);
         ended = true;
      });
      await tick();

      clock.advance(LIMIT_MS - 1);
      await tick();
      const endedBeforeLimit = ended;
      clock.advance(1);
      await reading;

      expect({ endedBeforeLimit, ended, warnings: warnings() }).toEqual({
         endedBeforeLimit: false,
         ended: true,
         warnings: [expect.stringContaining('A queued read has waited 5000 ms for 1 queued read(s)')]
      });
   });

   it('keeps a queued read holding a later write off once the limit has started the queued read it awaits', async () => {
      const { lock, clock } = makeLock(0);
      const resume = new Deferred<void>();
      let innerEnded = false;
      const reading = lock.read(async () => {
         await lock.read(() => undefined);
         innerEnded = true;
         await resume.promise;
      });
      await tick();
      clock.advance(LIMIT_MS);
      await tick();

      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();
      clock.advance(LIMIT_MS - 1);
      await tick();

      expect({ innerEnded, ran }).toEqual({ innerEnded: true, ran: false });
      resume.resolve();
      await Promise.all([reading, queued]);
      expect(ran).toBe(true);
   });

   it('keeps an immediate read holding writes off when the limit starts a queued read', async () => {
      const { lock, clock } = makeLock(0);
      const immediate = holdRead(lock);
      const reading = lock.read(() => lock.read(() => undefined));
      await tick();
      clock.advance(LIMIT_MS);
      await reading;

      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();
      clock.advance(LIMIT_MS - 1);
      await tick();

      expect(ran).toBe(false);
      immediate.release();
      await Promise.all([immediate.held, queued]);
   });

   it('leaves a read its caller released to take its hold back once its wait ends, and counts it as no holder', async () => {
      const { lock, clock, warnings } = makeLock(0);
      const waited = new Deferred();
      const goOn = new Deferred();
      // Without a tracker, the release frees every running read, which is this one alone.
      const released = lock.read(async () => {
         await releaseReadHolds(lock, () => waited.promise);
         await goOn.promise;
      }, ReadPriority.Immediate);
      await tick();
      const holding = holdRead(lock);
      const first = lock.write(() => undefined);
      await tick();
      clock.advance(LIMIT_MS);
      await first;

      waited.resolve();
      await tick();
      let ran = false;
      const second = lock.write(() => {
         ran = true;
      });
      await tick();
      const ranBeforeReadEnded = ran;
      goOn.resolve();
      await Promise.all([released, second]);

      expect({ ranBeforeReadEnded, warnings: warnings() }).toEqual({
         ranBeforeReadEnded: false,
         warnings: [expect.stringContaining('A write has waited 5000 ms for 1 read(s)')]
      });
      holding.release();
      await holding.held;
   });
});

describe('HydraniumWorkspaceLock read-hold limit of 0', () => {
   it('starts a write behind a queued read at the next timer tick', async () => {
      const clock = makeFakeClock();
      const lock = new HydraniumWorkspaceLock({ Clock: clock, Tracer: makeCapturingTracer(clock).tracer }, { readHoldLimitMs: 0 });
      const gate = new Deferred();
      const reading = lock.read(() => gate.promise);
      await tick();
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();

      clock.advance(0);
      await queued;

      expect(ran).toBe(true);
      gate.resolve();
      await reading;
   });
});

describe('HydraniumWorkspaceLock read-hold limit of Infinity', () => {
   it('keeps a write waiting for a read on a real clock, which fires a longer timer at once, and warns of nothing', async () => {
      const clock = new SystemClock();
      const { tracer, lines } = makeCapturingTracer(clock);
      const lock = new HydraniumWorkspaceLock(
         { Clock: clock, Tracer: tracer },
         { readHoldLimitMs: Infinity, stalledWriteWarnMs: Infinity }
      );
      const read = holdRead(lock);
      await tick();
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect({ ran, warnings: lines.filter(line => line.level === 'warn') }).toEqual({ ran: false, warnings: [] });
      read.release();
      await Promise.all([read.held, queued]);
   });
});

describe('HydraniumWorkspaceLock immediate reads', () => {
   it('hold a queued write until every read, including one that arrived while it was queued, ends', async () => {
      const { lock } = makeLock(0);
      const first = holdRead(lock);
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      const later = holdRead(lock);

      first.release();
      await first.held;
      await tick();
      const ranBeforeLaterEnded = ran;
      later.release();
      await Promise.all([later.held, queued]);

      expect({ ranBeforeLaterEnded, ran }).toEqual({ ranBeforeLaterEnded: false, ran: true });
   });

   it('hold a write queued on the lock off, in a host without a read-lock tracker', async () => {
      const { lock } = makeLock(0);
      const read = holdRead(lock);
      await tick();
      let ran = false;
      const queued = lock.write(() => {
         ran = true;
      });
      await tick();
      const ranWhileReading = ran;

      read.release();
      await Promise.all([read.held, queued]);

      expect({ ranWhileReading, ran }).toEqual({ ranWhileReading: false, ran: true });
   });

   it('settles every read as the lock Langium ships does, for each priority and outcome', async () => {
      const failure = new Error('read failed');
      const actions: Record<string, () => MaybePromise<unknown>> = {
         value: () => 'value',
         resolves: () => Promise.resolve('value'),
         throws: () => {
            throw failure;
         },
         rejects: () => Promise.reject(failure),
         'throws cancelled': () => {
            throw OperationCancelled;
         },
         'rejects cancelled': () => Promise.reject(OperationCancelled)
      };
      const settle = (read: Promise<unknown>): Promise<unknown> =>
         read.then(
            value => ({ value }),
            (reason: unknown) => ({ reason })
         );
      const outcomes = async (lock: DefaultWorkspaceLock): Promise<Record<string, unknown>> => {
         const settled: Record<string, unknown> = {};
         for (const [name, action] of Object.entries(actions)) {
            for (const priority of [ReadPriority.Immediate, ReadPriority.Normal]) {
               settled[`${name}, ${priority}`] = await settle(lock.read(action, priority));
            }
         }
         return settled;
      };

      const expected = await outcomes(new DefaultWorkspaceLock());
      expect(await outcomes(makeLock(0).lock)).toEqual(expected);
   });
});
