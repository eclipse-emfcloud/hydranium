/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the `lint-grammar` subcommand parent. The real run boots a head's
 * services and lints its grammar in a spawned child. Here we assert the parent
 * wires the driver path, node exec flags, and forwarded options via
 * `__spawnForTest`.
 */

import { describe, expect, it } from 'vitest';
import { buildLintGrammarDriverArgs, runLintGrammar } from '../src/commands/lint-grammar.js';

describe('lint-grammar', () => {
   it('buildLintGrammarDriverArgs: emits --services and omits optional flags when unset', () => {
      expect(buildLintGrammarDriverArgs({ servicesModule: './svc.js' })).toEqual(['--services', './svc.js']);
   });

   it('buildLintGrammarDriverArgs: repeats --name-property and appends --json/--strict', () => {
      expect(buildLintGrammarDriverArgs({ servicesModule: './svc.js', nameProperties: ['name', 'id'], json: true, strict: true })).toEqual([
         '--services',
         './svc.js',
         '--name-property',
         'name',
         '--name-property',
         'id',
         '--json',
         '--strict'
      ]);
   });

   it('runLintGrammar: spawns the driver (no --expose-gc) with the forwarded args', async () => {
      let captured: string[] = [];
      await runLintGrammar({
         servicesModule: './svc.js',
         nameProperties: ['id'],
         strict: true,
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured).not.toContain('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('lint-grammar-driver.js'))).toBe(true);
      expect(captured.slice(-5)).toEqual(['--services', './svc.js', '--name-property', 'id', '--strict']);
   });

   it('runLintGrammar: a non-zero child exit (lint failed) sets the process exit code', async () => {
      const previous = process.exitCode;
      await runLintGrammar({ servicesModule: './svc.js', __spawnForTest: () => Promise.resolve(1) });
      expect(process.exitCode).toBe(1);
      process.exitCode = previous;
   });
});
