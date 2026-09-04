/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the `reflect` subcommand parent. The real run boots a head's
 * services and reads its grammar reflection in a spawned child. Here we assert
 * the parent wires the driver path, node exec flags, and forwarded options via
 * `__spawnForTest`, without spawning anything.
 */

import { describe, expect, it } from 'vitest';
import { buildReflectDriverArgs, runReflect } from '../src/commands/reflect.js';

describe('reflect', () => {
   it('buildReflectDriverArgs: emits --services and omits --json when unset', () => {
      expect(buildReflectDriverArgs({ servicesModule: './svc.js' })).toEqual(['--services', './svc.js']);
   });

   it('buildReflectDriverArgs: appends --json when set', () => {
      expect(buildReflectDriverArgs({ servicesModule: './svc.js', json: true })).toEqual(['--services', './svc.js', '--json']);
   });

   it('buildReflectDriverArgs: forwards --out-file, which the driver and not the parent writes', () => {
      // Forwarded rather than handled here: the parent inherits the child's
      // stdio, so a parent-side write would have to re-capture a stream it
      // already gave away.
      expect(buildReflectDriverArgs({ servicesModule: './svc.js', outFile: '/tmp/r.md' })).toEqual([
         '--services',
         './svc.js',
         '--out-file',
         '/tmp/r.md'
      ]);
   });

   it('runReflect: spawns the driver (no --expose-gc) with the forwarded args and no workspace', async () => {
      let captured: string[] = [];
      await runReflect({
         servicesModule: './svc.js',
         json: true,
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured).not.toContain('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('reflect-driver.js'))).toBe(true);
      expect(captured.slice(-3)).toEqual(['--services', './svc.js', '--json']);
   });

   it('runReflect: a non-zero child exit sets the process exit code', async () => {
      const previous = process.exitCode;
      await runReflect({ servicesModule: './svc.js', __spawnForTest: () => Promise.resolve(1) });
      expect(process.exitCode).toBe(1);
      process.exitCode = previous;
   });
});
