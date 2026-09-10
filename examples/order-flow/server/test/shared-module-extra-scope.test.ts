/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `sharedModules.extra` is allowed to rebind.
 *
 * The tier is partial over the ADOPTER's shared services, not over Langium's.
 * That distinction is the whole subject here: the slots most worth rebinding
 * through it are framework additions — `Clock`, `Tracer`, `ModelService`,
 * `ProjectManager` — which the framework constructs with no options, so
 * rebinding the slot is the only way to boot one configured differently.
 * Narrowing the tier to Langium's own shared services excluded exactly those,
 * which made the documented use case uncompilable even though `inject` accepted
 * it at runtime.
 *
 * **This is primarily a compile-time contract, so the type IS the assertion.**
 * If the tier narrows again, this file stops BUILDING — `Clock` is not a
 * Langium shared service, so the binding below would no longer be expressible.
 * The runtime check then confirms the module actually reached the tree rather
 * than being accepted and dropped.
 *
 * Only a framework-added slot is exercised. A Langium slot would prove nothing
 * extra: it was always expressible, so it survives exactly the regression this
 * guards against.
 */

import { type Clock, SystemClock } from '@hydranium/protocol';
import { EmptyFileSystem } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';

describe('order-flow shared composition — the reach of the override tier', () => {
   it('rebinds a framework-added shared slot', () => {
      // Distinguishable from the framework's own by identity alone, which is all
      // the assertion needs and keeps the stand-in from having to behave.
      const clock: Clock = new SystemClock();
      const { shared } = createOrderFlowServices({ ...EmptyFileSystem }, { extraSharedModules: [{ Clock: () => clock }] });

      expect(shared.Clock).toBe(clock);
   });
});
