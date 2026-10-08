/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's data port, headless, over a `worker_threads` port pair in place of
 * the one the page transfers to the worker.
 */

import { NoopLogger } from '@hydranium/protocol';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import { describe, expect, it } from 'vitest';
import { WorkerDataPort } from '../src/page/worker-data-port.js';

describe('WorkerDataPort', () => {
   it('refuses a connection once disposed, rather than handing back one that never answers', async () => {
      const ports = makeMessagePortPair();
      try {
         // A Node port standing in for the browser one the page holds.
         const dataPort = new WorkerDataPort(ports.port1 as unknown as MessagePort, new NoopLogger());
         dataPort.dispose();

         await expect(dataPort.connect()).rejects.toThrow('disposed');
      } finally {
         ports.dispose();
      }
   });

   it('hands every generation the same connection', async () => {
      const ports = makeMessagePortPair();
      const dataPort = new WorkerDataPort(ports.port1 as unknown as MessagePort, new NoopLogger());
      try {
         const first = await dataPort.connect();

         // A second would leave the first reading the port, and disposing the
         // first would end the worker's head.
         expect(await dataPort.connect()).toBe(first);
      } finally {
         dataPort.dispose();
         ports.dispose();
      }
   });

   it('releases its connection when disposed, though no generation holds it any more', async () => {
      const ports = makeMessagePortPair();
      const dataPort = new WorkerDataPort(ports.port1 as unknown as MessagePort, new NoopLogger());
      try {
         const connection = await dataPort.connect();
         let released = false;
         connection.onDispose(() => (released = true));

         // As after a failed readiness check: the consumer holds no generation to drop.
         dataPort.dispose();

         expect(released).toBe(true);
      } finally {
         ports.dispose();
      }
   });
});
