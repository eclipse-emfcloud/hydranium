/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Internal to the package: its index does not re-export this module.

const queuedDeliveries = new WeakMap<object, Set<Promise<unknown>>>();

/**
 * The runs of the operations queued on `state`, each until what it answered
 * has been delivered, for a request that must not be answered ahead of them.
 */
export function queuedDeliveriesOf(state: object): Set<Promise<unknown>> {
   let deliveries = queuedDeliveries.get(state);
   if (deliveries === undefined) {
      deliveries = new Set();
      queuedDeliveries.set(state, deliveries);
   }
   return deliveries;
}

/**
 * Track `delivery` in {@link queuedDeliveriesOf} until it settles. Returns a
 * promise that settles as `delivery` does, so a rejection is still reported.
 */
export function trackQueuedDelivery<T>(state: object, delivery: Promise<T>): Promise<T> {
   const deliveries = queuedDeliveriesOf(state);
   deliveries.add(delivery);
   return delivery.finally(() => {
      deliveries.delete(delivery);
   });
}
