/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { makeFakeClock, tick } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { HydraniumWorkspaceLock } from '../../../src/langium/workspace/hydranium-workspace-lock.js';
import { makeCapturingTracer } from '../../../src/testing/index.js';

const WARN_MS = 1_000;

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
