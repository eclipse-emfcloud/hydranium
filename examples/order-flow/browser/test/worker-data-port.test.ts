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

import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import { describe, expect, it } from 'vitest';
import { WorkerDataPort } from '../src/page/worker-data-port.js';

describe('WorkerDataPort', () => {
   it('refuses a connection once disposed, rather than handing back one that never answers', async () => {
      const ports = makeMessagePortPair();
      try {
         // A Node port standing in for the browser one the page holds.
         const dataPort = new WorkerDataPort(ports.port1 as unknown as MessagePort);
         dataPort.dispose();

         await expect(dataPort.connect()).rejects.toThrow('disposed');
      } finally {
         ports.dispose();
      }
   });
});
