/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { heapCeilingArgs, isMemoryConstrained } from '../../src/node/heap-ceiling.js';

const GIB = 1024 ** 3;

describe('isMemoryConstrained', () => {
   it('is true for a cgroup limit below the host total', () => {
      expect(isMemoryConstrained(2 * GIB, 64 * GIB)).toBe(true);
   });

   it('is true for a cgroup limit equal to the host total', () => {
      // A limit set to exactly the host's RAM is still a limit; the OOM killer
      // watches it either way.
      expect(isMemoryConstrained(64 * GIB, 64 * GIB)).toBe(true);
   });

   it('is false when no limit is reported', () => {
      expect(isMemoryConstrained(0, 64 * GIB)).toBe(false);
   });

   it('is false for the cgroup v2 unlimited sentinel', () => {
      // Under cgroup v2 with no limit, `process.constrainedMemory()` reports
      // 2^64 rather than 0, so a bare `> 0` test would read every desktop as a
      // container and drop the ceiling there.
      expect(isMemoryConstrained(2 ** 64, 64 * GIB)).toBe(false);
   });

   it('is false for the cgroup v1 unlimited sentinel', () => {
      // The value the kernel actually writes, not 2 ** 63 — that rounds to a
      // different double, so pinning it would test an idealised number.
      expect(isMemoryConstrained(9223372036854771712, 64 * GIB)).toBe(false);
   });
});

describe('heapCeilingArgs', () => {
   const desktop = { constrained: 0, total: 64 * GIB };
   const container = { constrained: 2 * GIB, total: 64 * GIB };

   it('passes the desktop default when no limit is in force', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, ...desktop })).toEqual(['--max-old-space-size=8192']);
   });

   it('passes nothing under a cgroup limit, so Node sizes from the limit', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, ...container })).toEqual([]);
   });

   it('honours an explicit override, container or not', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '1024', ...container })).toEqual(['--max-old-space-size=1024']);
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '1024', ...desktop })).toEqual(['--max-old-space-size=1024']);
   });

   it('truncates a fractional override rather than emitting one V8 rejects', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '1024.7', ...desktop })).toEqual(['--max-old-space-size=1024']);
   });

   it('reads an explicit 0 as "let Node decide" rather than as a ceiling of zero', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '0', ...desktop })).toEqual([]);
   });

   it('reports a non-numeric override rather than dropping it in silence', () => {
      // `8G` is a natural thing to type into a variable measured in MiB, and an
      // operator who sees no complaint believes a ceiling is in force.
      const warnings: string[] = [];
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '8G', warn: message => warnings.push(message), ...desktop })).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('8G');
   });

   it('says nothing about an explicit 0, which is a decision rather than a typo', () => {
      const warnings: string[] = [];
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '0', warn: message => warnings.push(message), ...desktop })).toEqual([]);
      expect(warnings).toEqual([]);
   });

   it('warns and passes nothing for an override below the floor', () => {
      // V8 fatals at startup on a tiny heap, so a value that can only be a
      // misconfiguration (GiB typed where MiB was meant) must not reach the child.
      const warnings: string[] = [];
      expect(
         heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '4', minMb: 256, warn: message => warnings.push(message), ...desktop })
      ).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('4');
      expect(warnings[0]).toContain('256');
   });

   it('does not clamp a too-small override up, which would hide the misconfiguration', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '4', minMb: 256, warn: () => undefined, ...desktop })).not.toContain(
         '--max-old-space-size=256'
      );
   });

   it('applies no floor when none is given', () => {
      expect(heapCeilingArgs({ desktopDefaultMb: 8192, envValue: '4', ...desktop })).toEqual(['--max-old-space-size=4']);
   });
});
