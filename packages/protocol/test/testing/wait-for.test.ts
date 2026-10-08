/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { tick, waitFor } from '../../src/testing';

describe('waitFor', () => {
   it('resolves once the predicate becomes true', async () => {
      let flag = false;
      setTimeout(() => {
         flag = true;
      }, 5);

      await expect(waitFor(() => flag, { timeoutMs: 200, intervalMs: 1 })).resolves.toBeUndefined();
   });

   it('resolves when the event loop stalls past the deadline after the predicate became true', async () => {
      let flag = false;
      setTimeout(() => {
         flag = true;
      }, 5);
      const waiting = waitFor(() => flag, { timeoutMs: 50, intervalMs: 1 });

      // Every timer is due once the loop resumes, and the deadline fires after
      // the flag is set but before the next poll.
      const stalledUntil = Date.now() + 100;
      while (Date.now() < stalledUntil) {
         // stall the event loop
      }

      await expect(waiting).resolves.toBeUndefined();
   });

   it('rejects with the timeout message, caused by the throw, when the predicate throws at the deadline', async () => {
      let calls = 0;
      // The poll interval outlasts the deadline, so the second call is the deadline's.
      const predicate = (): boolean => {
         if (++calls > 1) {
            throw new Error('predicate threw');
         }
         return false;
      };

      await expect(waitFor(predicate, { timeoutMs: 10, intervalMs: 1000, message: 'no event arrived' })).rejects.toMatchObject({
         message: 'no event arrived',
         cause: { message: 'predicate threw' }
      });
   });

   it('rejects at once, caused by the throw, when the predicate throws on a poll', async () => {
      let calls = 0;
      const predicate = (): boolean => {
         if (++calls > 1) {
            throw new Error('predicate threw');
         }
         return false;
      };

      // A throw escaping the poll's timer would fail the run as an unhandled error.
      await expect(waitFor(predicate, { timeoutMs: 1000, intervalMs: 1, message: 'no event arrived' })).rejects.toMatchObject({
         message: 'no event arrived',
         cause: { message: 'predicate threw' }
      });
      expect(calls).toBe(2);
   });

   it('rejects, caused by the throw, when the predicate throws on its first check', async () => {
      const throwing = (): boolean => {
         throw new Error('predicate threw');
      };

      // A throw escaping `waitFor` itself would fail this before it awaits anything.
      const waiting = waitFor(throwing, { message: 'no event arrived' });

      await expect(waiting).rejects.toMatchObject({ message: 'no event arrived', cause: { message: 'predicate threw' } });
   });

   it('resolves immediately when the predicate is already true', async () => {
      await expect(waitFor(() => true, { timeoutMs: 1 })).resolves.toBeUndefined();
   });

   it('rejects with the supplied message when the predicate never becomes true', async () => {
      await expect(waitFor(() => false, { timeoutMs: 20, intervalMs: 1, message: 'no event arrived' })).rejects.toThrow('no event arrived');
   });
});

describe('tick', () => {
   it('resolves after yielding the event loop, letting a queued macrotask run first', async () => {
      const order: string[] = [];
      setTimeout(() => order.push('macrotask'), 0);

      await tick();

      // The 0ms macrotask queued before `tick`'s timer fired first — `tick` waited
      // a real event-loop turn rather than resolving synchronously on a microtask.
      expect(order).toEqual(['macrotask']);
   });

   it('honours an explicit delay', async () => {
      let fired = false;
      // The scheduled delay must EXCEED `tick`'s own 10ms default, or the
      // assertion is satisfied by the very default the explicit argument
      // exists to override — a `tick` that ignored its argument entirely
      // would still see this timer fire.
      setTimeout(() => {
         fired = true;
      }, 40);

      await tick(120);

      expect(fired).toBe(true);
   });
});
