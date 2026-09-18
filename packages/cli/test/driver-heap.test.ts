/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The heap ceiling every driver child is spawned under. The subcommand tests
 * assert that a command ROUTES through this; the cases below are where the
 * choice itself is pinned, because they can state the cgroup reading that the
 * machine running the suite would otherwise decide.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRIVER_HEAP_ENV, DRIVER_HEAP_MB, driverHeapArgs, MIN_DRIVER_HEAP_MB } from '../src/driver-heap.js';
import { pinHeapEnvUnset } from './heap-env.js';

const GIB = 1024 ** 3;
const desktop = { constrained: 0, total: 64 * GIB };
const container = { constrained: 2 * GIB, total: 64 * GIB };

describe('driverHeapArgs', () => {
   pinHeapEnvUnset();

   it('states the workstation ceiling on a machine with no cgroup limit', () => {
      expect(driverHeapArgs(desktop)).toEqual([`--max-old-space-size=${DRIVER_HEAP_MB}`]);
   });

   it('passes no ceiling under a cgroup limit, so Node sizes from the limit', () => {
      // The bug this exists to prevent: a ceiling above the limit lets old space
      // grow past it without V8 collecting hard, so the kernel kills the whole
      // cgroup instead of the child reporting a heap error.
      expect(driverHeapArgs(container)).toEqual([]);
   });

   it('lets an operator state a ceiling that survives the container test', () => {
      process.env[DRIVER_HEAP_ENV] = '12288';
      expect(driverHeapArgs(container)).toEqual(['--max-old-space-size=12288']);
   });

   it('reads an explicit 0 as "let Node decide"', () => {
      process.env[DRIVER_HEAP_ENV] = '0';
      expect(driverHeapArgs(desktop)).toEqual([]);
   });

   it('applies a floor and says so, so a GiB-for-MiB typo does not reach the child', () => {
      // Wired here rather than left to the caller: 8 is what someone means to
      // type as 8192, and the operator who typed it is the one person who
      // cannot tell it was dropped.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env[DRIVER_HEAP_ENV] = '8';
      expect(driverHeapArgs(desktop)).toEqual([]);
      expect(MIN_DRIVER_HEAP_MB).toBeGreaterThan(8);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(MIN_DRIVER_HEAP_MB)));
      warn.mockRestore();
   });

   it('reports a unit suffix rather than dropping it in silence', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env[DRIVER_HEAP_ENV] = '8G';
      expect(driverHeapArgs(desktop)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('8G'));
      warn.mockRestore();
   });
});
