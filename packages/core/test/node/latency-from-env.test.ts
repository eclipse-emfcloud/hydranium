/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatencyCollector } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY_ENV, isLatencyEnabled, latencyFromEnv } from '../../src/node/latency-from-env.js';

describe('latencyFromEnv', () => {
   const previous = process.env[DEFAULT_LATENCY_ENV];
   afterEach(() => {
      if (previous === undefined) {
         delete process.env[DEFAULT_LATENCY_ENV];
      } else {
         process.env[DEFAULT_LATENCY_ENV] = previous;
      }
   });

   it('returns a collector when the flag is set to a non-empty value', () => {
      process.env[DEFAULT_LATENCY_ENV] = '1';
      expect(isLatencyEnabled()).toBe(true);
      expect(latencyFromEnv()).toBeInstanceOf(LatencyCollector);
   });

   it('returns undefined when the flag is unset (the seam is never installed)', () => {
      delete process.env[DEFAULT_LATENCY_ENV];
      expect(isLatencyEnabled()).toBe(false);
      expect(latencyFromEnv()).toBeUndefined();
   });

   it('returns undefined when the flag is present but empty', () => {
      process.env[DEFAULT_LATENCY_ENV] = '';
      expect(isLatencyEnabled()).toBe(false);
      expect(latencyFromEnv()).toBeUndefined();
   });

   it('threads an injected clock into the collector so timing stays deterministic', () => {
      process.env[DEFAULT_LATENCY_ENV] = '1';
      const clock = makeFakeClock();
      const latency = latencyFromEnv(clock);
      latency?.time('m', () => clock.advance(7));
      expect(latency?.report().methods[0]?.totalMs).toBe(7);
   });
});
