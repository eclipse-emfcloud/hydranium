/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the `validate` subcommand parent. The real run boots a head's
 * services and builds a workspace in a spawned child. Here we assert the parent
 * wires the driver path, node exec flags, and forwarded options via
 * `__spawnForTest`, without spawning anything.
 */

import { describe, expect, it } from 'vitest';
import { buildValidateDriverArgs, runValidate } from '../src/commands/validate.js';

describe('validate', () => {
   it('buildValidateDriverArgs: emits --services + workspace and omits unset flags', () => {
      expect(buildValidateDriverArgs({ servicesModule: './svc.js', workspace: '/ws' })).toEqual(['--services', './svc.js', '/ws']);
   });

   it('buildValidateDriverArgs: appends --json and --strict when set', () => {
      expect(buildValidateDriverArgs({ servicesModule: './svc.js', workspace: '/ws', json: true, strict: true })).toEqual([
         '--services',
         './svc.js',
         '/ws',
         '--json',
         '--strict'
      ]);
   });

   it('buildValidateDriverArgs: forwards --out-file after the gate flags', () => {
      expect(buildValidateDriverArgs({ servicesModule: './svc.js', workspace: '/ws', strict: true, outFile: '/tmp/v.txt' })).toEqual([
         '--services',
         './svc.js',
         '/ws',
         '--strict',
         '--out-file',
         '/tmp/v.txt'
      ]);
   });

   it('runValidate: spawns the driver (no --expose-gc) with the forwarded args', async () => {
      let captured: string[] = [];
      await runValidate({
         servicesModule: './svc.js',
         workspace: '/ws',
         strict: true,
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured).not.toContain('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('validate-driver.js'))).toBe(true);
      expect(captured.slice(-4)).toEqual(['--services', './svc.js', '/ws', '--strict']);
   });

   it('runValidate: a non-zero child exit (validation failed) sets the process exit code', async () => {
      const previous = process.exitCode;
      await runValidate({ servicesModule: './svc.js', workspace: '/ws', __spawnForTest: () => Promise.resolve(1) });
      expect(process.exitCode).toBe(1);
      process.exitCode = previous;
   });
});
