/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { formatLatencyReport, LatencyCollector } from '../src/latency-collector.js';
import { makeFakeClock } from '../src/testing/fake-clock.js';

describe('LatencyCollector', () => {
   it('aggregates per-method count, total, and percentiles from recorded durations', () => {
      const collector = new LatencyCollector();
      for (const ms of [10, 20, 30, 40, 50]) {
         collector.record('completion', ms);
      }
      collector.record('hover', 5);
      const report = collector.report();
      const completion = report.methods.find(methodLatency => methodLatency.method === 'completion');
      expect(completion).toEqual({ method: 'completion', count: 5, totalMs: 150, maxMs: 50, p50Ms: 30, p99Ms: 50 });
   });

   it('orders methods by total time descending (hottest first)', () => {
      const collector = new LatencyCollector();
      collector.record('a', 5);
      collector.record('b', 100);
      collector.record('b', 100);
      expect(collector.report().methods.map(methodLatency => methodLatency.method)).toEqual(['b', 'a']);
   });

   it('times an async call and records its elapsed on a fake clock', async () => {
      const clock = makeFakeClock();
      const collector = new LatencyCollector(clock);
      const result = await collector.time('save', async () => {
         clock.advance(25);
         return 'ok';
      });
      expect(result).toBe('ok');
      expect(collector.report().methods.find(methodLatency => methodLatency.method === 'save')?.totalMs).toBe(25);
   });

   it('records the elapsed even when the timed call rejects', async () => {
      const clock = makeFakeClock();
      const collector = new LatencyCollector(clock);
      await expect(
         collector.time('boom', async () => {
            clock.advance(7);
            throw new Error('x');
         })
      ).rejects.toThrow('x');
      expect(collector.report().methods.find(methodLatency => methodLatency.method === 'boom')?.totalMs).toBe(7);
   });

   it('reset clears methods and restarts the window', () => {
      const clock = makeFakeClock();
      const collector = new LatencyCollector(clock);
      collector.record('a', 1);
      clock.advance(100);
      collector.reset();
      expect(collector.report().methods).toEqual([]);
      expect(collector.report().windowMs).toBe(0);
   });

   it('report windowMs reflects elapsed since construction', () => {
      const clock = makeFakeClock();
      const collector = new LatencyCollector(clock);
      clock.advance(500);
      expect(collector.report().windowMs).toBe(500);
   });
});

describe('LatencyCollector retention', () => {
   it('defaults to keep-all so every sample is retained for exact percentiles', () => {
      const collector = new LatencyCollector();
      for (let ms = 1; ms <= 100; ms++) {
         collector.record('m', ms);
      }
      const method = collector.report().methods[0];
      expect(method.count).toBe(100);
      expect(method.p50Ms).toBe(50);
   });

   it('ring-buffer windows the percentiles while count, total and max stay lifetime', () => {
      const collector = new LatencyCollector(makeFakeClock(), { kind: 'ring-buffer', maxSamplesPerMethod: 3 });
      for (const ms of [1, 2, 3, 4, 5]) {
         collector.record('m', ms);
      }
      const method = collector.report().methods[0];
      expect(method.count).toBe(5);
      expect(method.totalMs).toBe(15);
      expect(method.maxMs).toBe(5);
      // Percentiles cover only the retained window {3, 4, 5}; keep-all would report p50 of 3.
      expect(method.p50Ms).toBe(4);
   });

   it('keeps the lifetime max even after the spike ages out of the ring-buffer window', () => {
      const collector = new LatencyCollector(makeFakeClock(), { kind: 'ring-buffer', maxSamplesPerMethod: 2 });
      for (const ms of [100, 1, 1]) {
         collector.record('m', ms);
      }
      const method = collector.report().methods[0];
      expect(method.maxMs).toBe(100);
      expect(method.p99Ms).toBe(1);
      expect(method.count).toBe(3);
   });

   it('rejects a ring-buffer cap below 1', () => {
      expect(() => new LatencyCollector(makeFakeClock(), { kind: 'ring-buffer', maxSamplesPerMethod: 0 })).toThrow(RangeError);
   });
});

describe('formatLatencyReport (pure)', () => {
   it('renders a ranked per-method latency line with count and percentiles', () => {
      const collector = new LatencyCollector();
      collector.record('completion', 80);
      collector.record('completion', 20);
      const text = formatLatencyReport(collector.report());
      expect(text).toContain('completion');
      expect(text).toContain('n=2');
      expect(text).toContain('p99');
   });
});
