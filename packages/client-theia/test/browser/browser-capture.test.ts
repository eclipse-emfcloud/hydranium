/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { captureBrowserRuntime, formatBrowserRuntime } from '../../src/browser/browser-capture';

type MutablePerformance = Performance & {
   measureUserAgentSpecificMemory?: unknown;
   memory?: unknown;
};

const perf = globalThis.performance as MutablePerformance;

describe('captureBrowserRuntime', () => {
   afterEach(() => {
      delete perf.measureUserAgentSpecificMemory;
      delete perf.memory;
   });

   it('prefers measureUserAgentSpecificMemory when available', async () => {
      perf.measureUserAgentSpecificMemory = async () => ({ bytes: 12_345, breakdown: [{ bytes: 12_345, types: ['JS'] }] });
      const report = await captureBrowserRuntime();
      expect(report.source).toBe('measureUserAgentSpecificMemory');
      expect(report.after.totalBytes).toBe(12_345);
      expect(report.after.breakdown).toBeDefined();
   });

   it('falls back to performance.memory when the precise API is absent', async () => {
      perf.memory = { usedJSHeapSize: 100, totalJSHeapSize: 200, jsHeapSizeLimit: 400 };
      const report = await captureBrowserRuntime();
      expect(report.source).toBe('performance.memory');
      expect(report.after).toEqual({ jsHeapUsedBytes: 100, jsHeapTotalBytes: 200, jsHeapLimitBytes: 400 });
   });

   it('falls back to performance.memory when the precise API throws', async () => {
      perf.measureUserAgentSpecificMemory = async () => {
         throw new Error('cross-origin isolation required');
      };
      perf.memory = { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 };
      const report = await captureBrowserRuntime();
      expect(report.source).toBe('performance.memory');
   });

   it('reports unavailable with an empty after sample when neither API exists', async () => {
      const report = await captureBrowserRuntime();
      expect(report.source).toBe('unavailable');
      expect(report.after).toEqual({});
   });
});

describe('formatBrowserRuntime (pure)', () => {
   it('renders the precise total in MB', () => {
      expect(formatBrowserRuntime({ source: 'measureUserAgentSpecificMemory', after: { totalBytes: 5 * 1024 * 1024 } })).toContain(
         '5.0 MB'
      );
   });

   it('renders the js-heap triple for the fallback', () => {
      const text = formatBrowserRuntime({
         source: 'performance.memory',
         after: { jsHeapUsedBytes: 1024 * 1024, jsHeapTotalBytes: 2 * 1024 * 1024, jsHeapLimitBytes: 4 * 1024 * 1024 }
      });
      expect(text).toContain('JS heap');
      expect(text).toContain('1.0 MB');
   });

   it('notes unavailability', () => {
      expect(formatBrowserRuntime({ source: 'unavailable', after: {} })).toMatch(/unavailable/i);
   });
});
