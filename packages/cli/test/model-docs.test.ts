/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the `model-docs` subcommand parent. The real run boots a head's
 * services and renders its model reference in a spawned child. Here we assert
 * the parent wires the driver path, node exec flags, and forwarded args via
 * `__spawnForTest`.
 */

import { describe, expect, it } from 'vitest';
import { buildModelDocsDriverArgs, runModelDocs } from '../src/commands/model-docs.js';

describe('model-docs', () => {
   it('buildModelDocsDriverArgs: emits --services and the module', () => {
      expect(buildModelDocsDriverArgs({ servicesModule: './svc.js' })).toEqual(['--services', './svc.js']);
   });

   it('buildModelDocsDriverArgs: forwards --out-file when set, and nothing when not', () => {
      expect(buildModelDocsDriverArgs({ servicesModule: './svc.js', outFile: '/tmp/m.md' })).toEqual([
         '--services',
         './svc.js',
         '--out-file',
         '/tmp/m.md'
      ]);
   });

   it('runModelDocs: spawns the driver (no --expose-gc) with the forwarded args', async () => {
      let captured: string[] = [];
      await runModelDocs({
         servicesModule: './svc.js',
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured).not.toContain('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('model-docs-driver.js'))).toBe(true);
      expect(captured.slice(-2)).toEqual(['--services', './svc.js']);
   });

   it('runModelDocs: a non-zero child exit sets the process exit code', async () => {
      const previous = process.exitCode;
      await runModelDocs({ servicesModule: './svc.js', __spawnForTest: () => Promise.resolve(1) });
      expect(process.exitCode).toBe(1);
      process.exitCode = previous;
   });
});
