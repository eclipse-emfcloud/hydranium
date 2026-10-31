/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { PendingWorkTracker } from '../src/pending-work-tracker.js';
import { Deferred } from '../src/util.js';
import { captureUnhandledRejections } from '../src/testing/node/unhandled-rejections.js';
import { tick, waitFor } from '../src/testing/wait-for.js';

describe('PendingWorkTracker', () => {
   it('counts work from its tracking until it resolves or rejects', async () => {
      const tracker = new PendingWorkTracker();
      const resolving = new Deferred<string>();
      const rejecting = new Deferred<string>();
      const resolved = tracker.track(resolving.promise);
      tracker.track(rejecting.promise).catch(() => undefined);
      expect(tracker.size).toBe(2);
      expect(tracker.isIdle).toBe(false);

      resolving.resolve('done');
      rejecting.reject(new Error('failed'));
      await tracker.whenSettled();
      await expect(resolved).resolves.toBe('done');
      expect(tracker.size).toBe(0);
      expect(tracker.isIdle).toBe(true);
   });

   it('waits for the work pending when asked, not for work tracked later', async () => {
      const tracker = new PendingWorkTracker();
      const earlier = new Deferred();
      const later = new Deferred();
      tracker.track(earlier.promise);
      let settled = false;
      const waiting = tracker.whenSettled().then(() => {
         settled = true;
      });
      tracker.track(later.promise);

      await Promise.resolve();
      expect(settled).toBe(false);
      earlier.resolve();
      await waiting;
      expect(tracker.size).toBe(1);
   });

   it('settles at once, and never rejects, when the pending work fails', async () => {
      const tracker = new PendingWorkTracker();
      await expect(tracker.whenSettled()).resolves.toBeUndefined();
      const failing = new Deferred();
      tracker.track(failing.promise).catch(() => undefined);
      failing.reject(new Error('failed'));
      await expect(tracker.whenSettled()).resolves.toBeUndefined();
   });

   it('reports the failure of work whose caller dropped the promise it handed back', async () => {
      const failure = new Error('dropped');
      const unhandled = await captureUnhandledRejections(async rejections => {
         const failing = new Deferred();
         void new PendingWorkTracker().track(failing.promise);
         failing.reject(failure);
         await waitFor(() => rejections.length > 0);
         await tick();
         return rejections;
      });
      expect(unhandled).toEqual([failure]);
   });
});
