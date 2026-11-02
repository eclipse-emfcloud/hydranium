/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred } from '@hydranium/protocol';
import { makeFakeClock, tick } from '@hydranium/protocol/testing';
import { ReadPriority } from '@hydranium/langium';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HydraniumWorkspaceLock } from '../../../src/langium/workspace/hydranium-workspace-lock.js';
import {
   createSynchronousReadLockScope,
   isInsideReadLock,
   ReadLockWaitError,
   refuseWaitInRead,
   setReadLockScope
} from '../../../src/langium/workspace/read-lock-scope.js';
import { nodeReadLockScope } from '../../../src/node/write-lock-scope-node.js';
import { makeCapturingTracer } from '../../../src/testing/index.js';

const WARN_MS = 1_000;
/** The lock's default `readWaitGraceMs`. */
const GRACE_MS = 1_000;

function makeLock(stalledWriteWarnMs = WARN_MS) {
   const clock = makeFakeClock();
   const { tracer, lines } = makeCapturingTracer(clock);
   const lock = new HydraniumWorkspaceLock({ Clock: clock, Tracer: tracer }, { stalledWriteWarnMs });
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

   it('times nothing when the check is off', async () => {
      const { lock, clock, warnings } = makeLock(0);
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS * 2);
      expect(warnings()).toEqual([]);
      expect(clock.pendingTimers()).toBe(0);

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
});

describe('HydraniumWorkspaceLock write cancellations', () => {
   it('counts none for a write queued after the write before it ended', async () => {
      const { lock } = makeLock();
      await lock.write(() => undefined);
      const before = lock.writeCancellations;
      await lock.write(() => undefined);
      expect(lock.writeCancellations).toBe(before);
   });

   it('counts one for a write queued while another is still queued', async () => {
      const { lock } = makeLock();
      const first = lock.write(() => undefined);
      const before = lock.writeCancellations;
      const second = lock.write(() => undefined);
      expect(lock.writeCancellations).toBe(before + 1);
      await Promise.all([first, second]);
   });

   it('counts one for a write queued while another runs', async () => {
      const { lock } = makeLock();
      const { release, held } = await holdWrite(lock);
      const before = lock.writeCancellations;
      const next = lock.write(() => undefined);
      expect(lock.writeCancellations).toBe(before + 1);
      release();
      await Promise.all([held, next]);
   });

   it('counts none for a cancelWrite with no write queued or running', async () => {
      const { lock } = makeLock();
      await lock.write(() => undefined);
      const before = lock.writeCancellations;
      lock.cancelWrite();
      expect(lock.writeCancellations).toBe(before);
   });
});

describe('HydraniumWorkspaceLock reads', () => {
   beforeEach(() => setReadLockScope(nodeReadLockScope));
   afterEach(() => setReadLockScope(createSynchronousReadLockScope()));

   it('hold off a write queued while a request runs until the request ends, as Langium does', async () => {
      const { lock } = makeLock();
      const order: string[] = [];
      const request = new Deferred<void>();

      const reading = lock.read(async () => {
         await request.promise;
         order.push('request');
      }, ReadPriority.Immediate);
      const writing = lock.write(() => void order.push('write'));
      await tick(10);
      request.resolve();
      await Promise.all([reading, writing]);

      expect(order).toEqual(['request', 'write']);
   });

   it.each([
      ['a request', ReadPriority.Immediate],
      ['a queued read', ReadPriority.Normal]
   ] as const)('mark %s as a read while it runs, and no task it leaves running once it has ended', async (_title, priority) => {
      const { lock } = makeLock();
      let later!: Promise<boolean>;

      const inside = await lock.read(() => {
         later = tick(5).then(isInsideReadLock);
         return isInsideReadLock();
      }, priority);

      expect(inside).toBe(true);
      expect(await later).toBe(false);
      expect(isInsideReadLock()).toBe(false);
   });

   it('mark no read inside a write a request queued', async () => {
      const { lock } = makeLock();
      let inside: boolean | undefined;
      let written!: Promise<void>;

      await lock.read(() => {
         written = lock.write(() => void (inside = isInsideReadLock()));
      }, ReadPriority.Immediate);
      await written;

      expect(inside).toBe(false);
   });

   it('warn once a write has waited the configured time for a request that queued it', async () => {
      const { lock, clock, warnings } = makeLock();
      const request = new Deferred<void>();

      const reading = lock.read(async () => {
         void lock.write(() => undefined);
         await request.promise;
      }, ReadPriority.Immediate);
      await tick(1);
      clock.advance(WARN_MS);

      expect(warnings()).toEqual([
         `A write has waited ${WARN_MS} ms for running requests or reads to end. It was queued inside one, which never ends if it awaits the write.`
      ]);
      request.resolve();
      await reading;
   });

   it('warn once for the writes queued during one long request', async () => {
      const { lock, clock, warnings } = makeLock();
      const request = new Deferred<void>();
      const reading = lock.read(() => request.promise, ReadPriority.Immediate);
      await tick(1);

      const writes = [lock.write(() => undefined), lock.write(() => undefined), lock.write(() => undefined)];
      clock.advance(WARN_MS);

      expect(warnings()).toHaveLength(1);
      request.resolve();
      await Promise.all([reading, ...writes]);
   });

   it('warn a write queued by a read that has ended as held off by the reads still running', async () => {
      const { lock, clock, warnings } = makeLock();
      const other = new Deferred<void>();
      const otherRead = lock.read(() => other.promise, ReadPriority.Immediate);

      await lock.read(() => void lock.write(() => undefined), ReadPriority.Immediate);
      clock.advance(WARN_MS);

      expect(warnings()).toEqual([
         `A write has waited ${WARN_MS} ms for running requests or reads to end. A long request delays it, and one that awaits a build or write holds it off for good.`
      ]);
      other.resolve();
      await otherRead;
   });

   it('let a request wait past the grace period for a queued read that waits only for a running batch', async () => {
      const { lock, clock } = makeLock();
      const batch = new Deferred<void>();
      const batchRead = lock.read(() => batch.promise);
      await tick(1);

      const outcome = lock.read(() => lock.read(() => 'queued'), ReadPriority.Immediate).catch((error: unknown) => error);
      await tick(1);
      clock.advance(3 * GRACE_MS);
      batch.resolve();
      await batchRead;

      expect(await outcome).toBe('queued');
   });

   it('let a request wait past the grace period for a queued read that has started, while a write queues behind it', async () => {
      const { lock, clock } = makeLock();
      const nested = new Deferred<string>();
      let started = false;

      const outcome = lock
         .read(
            () =>
               lock.read(() => {
                  started = true;
                  return nested.promise;
               }),
            ReadPriority.Immediate
         )
         .catch((error: unknown) => error);
      await tick(1);
      expect(started).toBe(true);
      const writing = lock.write(() => undefined);
      await tick(1);
      clock.advance(3 * GRACE_MS);
      nested.resolve('nested');

      expect(await outcome).toBe('nested');
      await writing;
   });

   it('refuse a request its wait for a queued read once a write is queued ahead of it, and still run that read once its turn comes, as a caller that does not await it relies on', async () => {
      const { lock, clock } = makeLock();
      const batch = new Deferred<void>();
      const batchRead = lock.read(() => batch.promise);
      await tick(1);
      let ran = false;

      const outcome = lock.read(() => lock.read(() => void (ran = true)), ReadPriority.Immediate).catch((error: unknown) => error);
      const writing = lock.write(() => undefined);
      await tick(1);
      clock.advance(GRACE_MS);

      expect(await outcome).toBeInstanceOf(ReadLockWaitError);
      batch.resolve();
      await Promise.all([batchRead, writing]);
      // Queued after the refused read, so it runs once that one has had its turn.
      await lock.read(() => undefined);
      expect(ran).toBe(true);
   });

   it.each([
      ['a read on one lock', ReadPriority.Normal],
      ['a request on one lock, with a write queued on the other,', ReadPriority.Immediate]
   ])("let %s wait past the grace period for a queued read on another lock's running batch", async (_caller, priority) => {
      const { lock } = makeLock();
      const { lock: other, clock: otherClock } = makeLock();
      const batch = new Deferred<void>();
      const batchRead = other.read(() => batch.promise);
      await tick(1);

      const outcome = lock.read(() => other.read(() => 'queued'), priority).catch((error: unknown) => error);
      const writing = priority === ReadPriority.Immediate ? other.write(() => undefined) : Promise.resolve();
      await tick(1);
      otherClock.advance(3 * GRACE_MS);
      batch.resolve();
      await Promise.all([batchRead, writing]);

      expect(await outcome).toBe('queued');
   });

   it.each([
      ['goes on past the grace period for a build of another lock', false],
      ["is refused past the grace period for a build of the read's own lock", true]
   ])('a wait inside a read %s', async (_title, ownLock) => {
      const { lock, clock } = makeLock();
      const { lock: other } = makeLock();
      const build = new Deferred<string>();

      const outcome = lock
         .read(() => refuseWaitInRead('A build', build.promise, ownLock ? lock : other), ReadPriority.Immediate)
         .catch((error: unknown) => error);
      await tick(1);
      clock.advance(3 * GRACE_MS);
      build.resolve('built');

      if (ownLock) {
         expect(await outcome).toBeInstanceOf(ReadLockWaitError);
      } else {
         expect(await outcome).toBe('built');
      }
   });

   it('warn about no write that starts within the configured time', async () => {
      const { lock, clock, warnings } = makeLock();

      await lock.read(() => undefined, ReadPriority.Immediate);
      await lock.write(() => undefined);
      clock.advance(WARN_MS);

      expect(warnings()).toEqual([]);
   });
});
