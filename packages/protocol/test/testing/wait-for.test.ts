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
