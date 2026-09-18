/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach } from 'vitest';
import { DRIVER_HEAP_ENV } from '../src/driver-heap.js';

/**
 * Take the ambient heap override out of the picture for the enclosing suite,
 * and put it back afterwards.
 *
 * Any assertion naming a concrete ceiling reads the environment otherwise, so a
 * contributor who exports the override sees those tests fail on their machine
 * and nowhere else — a failure that looks like the code and is not.
 */
export function pinHeapEnvUnset(): void {
   const previous = process.env[DRIVER_HEAP_ENV];
   beforeEach(() => {
      delete process.env[DRIVER_HEAP_ENV];
   });
   afterEach(() => {
      if (previous === undefined) {
         delete process.env[DRIVER_HEAP_ENV];
      } else {
         process.env[DRIVER_HEAP_ENV] = previous;
      }
   });
}
