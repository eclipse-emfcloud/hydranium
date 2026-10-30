/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { captureUnhandledRejections } from '@hydranium/core/testing/node';
import { Deferred } from '@hydranium/protocol';
import { queuedDeliveriesOf, trackQueuedDelivery } from '../src/command/queued-deliveries.js';

describe('trackQueuedDelivery', () => {
   it('tracks a delivery until it settles, and settles as it does', async () => {
      const state = {};
      const delivery = new Deferred<string>();
      const tracked = trackQueuedDelivery(state, delivery.promise);
      expect(queuedDeliveriesOf(state).size).toBe(1);

      delivery.resolve('delivered');
      await expect(tracked).resolves.toBe('delivered');
      expect(queuedDeliveriesOf(state).size).toBe(0);
   });

   it('reports the rejection of a delivery its caller drops', async () => {
      await captureUnhandledRejections(async unhandled => {
         const state = {};
         const delivery = new Deferred();
         const failure = new Error('could not report');
         void trackQueuedDelivery(state, delivery.promise);
         delivery.reject(failure);
         await new Promise(resolve => setTimeout(resolve, 0));
         expect(unhandled).toEqual([failure]);
         expect(queuedDeliveriesOf(state).size).toBe(0);
      });
   });
});
