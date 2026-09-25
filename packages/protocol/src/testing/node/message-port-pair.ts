/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MessageChannel } from 'node:worker_threads';
import type { TransferredMessagePort } from '../../client/post-message-transport';

/**
 * The two ends of a `worker_threads` `MessageChannel`, typed as the transferred
 * browser ports `createMessagePortTransport` takes. Node's port clones and keeps
 * order as a browser's does, which is what lets a headless test stand in for a
 * worker.
 *
 * `dispose` closes both ports. Node reports that as a close and a browser port
 * reports nothing, so a test that asserts on a close does so before teardown.
 */
export interface MessagePortPair {
   readonly port1: TransferredMessagePort;
   readonly port2: TransferredMessagePort;
   dispose(): void;
}

export function makeMessagePortPair(): MessagePortPair {
   const channel = new MessageChannel();
   return {
      // Node's port satisfies the structural type at runtime; the cast records
      // one platform's port standing in for the other's.
      port1: channel.port1 as unknown as TransferredMessagePort,
      port2: channel.port2 as unknown as TransferredMessagePort,
      dispose(): void {
         channel.port1.close();
         channel.port2.close();
      }
   };
}
