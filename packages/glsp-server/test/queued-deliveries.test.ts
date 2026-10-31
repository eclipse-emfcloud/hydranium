/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { captureUnhandledRejections } from '@hydranium/protocol/testing/node';
import { Deferred } from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { queuedDeliveriesOf, trackQueuedDelivery } from '../src/command/queued-deliveries.js';

describe('trackQueuedDelivery', () => {
   it('forgets a failed delivery and still reports its failure', async () => {
      const failure = new Error('delivery failed');
      const state = {};
      const unhandled = await captureUnhandledRejections(async rejections => {
         const delivery = new Deferred();
         trackQueuedDelivery(state, delivery.promise);
         expect(queuedDeliveriesOf(state).size).toBe(1);

         delivery.reject(failure);
         await waitFor(() => rejections.length > 0);
         await tick();
         return rejections;
      });

      expect(queuedDeliveriesOf(state).size).toBe(0);
      expect(unhandled).toEqual([failure]);
   });
});
