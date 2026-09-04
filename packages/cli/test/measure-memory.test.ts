/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildDriverArgs, parseProfileDimensions } from '../src/commands/measure-memory.js';

describe('parseProfileDimensions', () => {
   it('maps the documented dimension tokens', () => {
      expect(parseProfileDimensions('cpu,alloc,gc,eld')).toEqual({ cpu: true, allocation: true, gc: true, eventLoopDelay: true });
   });

   it('maps heap to a retained snapshot', () => {
      expect(parseProfileDimensions('heap')).toEqual({ heapSnapshot: true });
   });

   it('tolerates whitespace and accepts a single dimension', () => {
      expect(parseProfileDimensions(' cpu , alloc ')).toEqual({ cpu: true, allocation: true });
   });

   it('throws on an unknown dimension', () => {
      expect(() => parseProfileDimensions('cpu,bogus')).toThrow(/bogus/);
   });
});

describe('buildDriverArgs (profiling flags)', () => {
   it('threads --profile and --session-out through', () => {
      const args = buildDriverArgs({ servicesModule: 'm.js', workspace: '/ws', profile: 'cpu,alloc', sessionOut: '/out' });
      expect(args[args.indexOf('--profile') + 1]).toBe('cpu,alloc');
      expect(args[args.indexOf('--session-out') + 1]).toBe('/out');
   });

   it('omits the profiling flags when not requested', () => {
      const args = buildDriverArgs({ servicesModule: 'm.js', workspace: '/ws' });
      expect(args).not.toContain('--profile');
      expect(args).not.toContain('--session-out');
   });
});

describe('buildDriverArgs (--json)', () => {
   it('forwards --json, which the driver and not the parent renders', () => {
      // Forwarded rather than handled here: the result object exists only inside
      // the child, so the parent has nothing to serialise.
      expect(buildDriverArgs({ servicesModule: 'm.js', workspace: '/ws', json: true })).toContain('--json');
   });

   it('omits --json when unset, so the progress lines stay the default', () => {
      expect(buildDriverArgs({ servicesModule: 'm.js', workspace: '/ws' })).not.toContain('--json');
      expect(buildDriverArgs({ servicesModule: 'm.js', workspace: '/ws', json: false })).not.toContain('--json');
   });
});
