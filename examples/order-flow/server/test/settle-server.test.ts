/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { makeServices, settleServer } from './order-flow-harness.js';

describe('settleServer', () => {
   it('resolves for services whose workspace was never initialized', async () => {
      const harness = makeServices();
      await expect(settleServer(harness.shared, 60_000)).resolves.toBeUndefined();
   });

   it('gives up without throwing once a write stays stuck past its bound', async () => {
      const harness = makeServices();
      const release = new Deferred<void>();
      const stuck = harness.shared.workspace.WorkspaceLock.write(() => release.promise);
      try {
         await expect(settleServer(harness.shared, 50)).resolves.toBeUndefined();
      } finally {
         release.resolve();
         await stuck;
      }
   });
});
