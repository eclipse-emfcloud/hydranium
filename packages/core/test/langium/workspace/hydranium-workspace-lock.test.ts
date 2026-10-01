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
   const errors = (): string[] => lines.filter(line => line.level === 'error').map(line => line.message);
   return { lock, clock, errors };
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
   it('logs one error for a write still running the configured time after it was cancelled', async () => {
      const { lock, clock, errors } = makeLock();
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS - 1);
      expect(errors()).toEqual([]);
      clock.advance(1);
      expect(errors()).toEqual([expect.stringContaining('still running 1000 ms after it was cancelled')]);
      clock.advance(WARN_MS * 5);
      expect(errors()).toHaveLength(1);

      release();
      await Promise.all([held, queued]);
   });

   it('logs nothing for a cancelled write that ends in time', async () => {
      const { lock, clock, errors } = makeLock();
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      release();
      await Promise.all([held, queued]);
      clock.advance(WARN_MS * 2);
      expect(errors()).toEqual([]);
      expect(clock.pendingTimers()).toBe(0);
   });

   it('times nothing when the check is off', async () => {
      const { lock, clock, errors } = makeLock(0);
      const { release, held } = await holdWrite(lock);
      const queued = lock.write(() => undefined);

      clock.advance(WARN_MS * 2);
      expect(errors()).toEqual([]);
      expect(clock.pendingTimers()).toBe(0);

      release();
      await Promise.all([held, queued]);
   });

   it('diagnoses a write that waits for a write queued behind it', async () => {
      // The shape a model-service call from inside a build takes where no tracker
      // can reject it: the inner write waits for the outer to end, and the outer
      // waits for the inner, so neither settles.
      const { lock, clock, errors } = makeLock();
      let innerSettled = false;
      void lock.write(async () => {
         await lock.write(() => undefined);
         innerSettled = true;
      });
      await tick();

      clock.advance(WARN_MS);
      expect(innerSettled).toBe(false);
      expect(errors()).toEqual([expect.stringContaining('from inside a build')]);
   });
});
