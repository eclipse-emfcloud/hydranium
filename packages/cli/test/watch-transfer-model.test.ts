/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchTransferModel } from '../src/commands/generate-transfer-model.js';

describe('watchTransferModel', () => {
   let scratch: string | undefined;
   let controller: AbortController | undefined;

   afterEach(() => {
      controller?.abort();
      vi.restoreAllMocks();
      if (scratch !== undefined) {
         rmSync(scratch, { recursive: true, force: true });
      }
   });

   /**
    * Watch an AST file in its own `generated/` directory. The inputs do not
    * parse, so every run reports a failure, and the failures are what is
    * counted.
    */
   async function startWatch(): Promise<{ generated: string; astFile: string; runs: () => number }> {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-watch-transfer-'));
      const generated = path.join(scratch, 'generated');
      mkdirSync(generated);
      const astFile = path.join(generated, 'ast.ts');
      writeFileSync(astFile, 'export {};\n');
      writeFileSync(path.join(scratch, 'ast.ts'), 'export {};\n');
      const failures = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      controller = new AbortController();
      void watchTransferModel(
         { astFile, augmentationFile: path.join(scratch, 'ast.ts'), outFile: path.join(scratch, 'out.ts') },
         { signal: controller.signal }
      );
      // The poll takes its baseline on its first tick; a change before it
      // would become the baseline rather than a change.
      await new Promise(resolve => setTimeout(resolve, 600));
      return { generated, astFile, runs: () => failures.mock.calls.length };
   }

   it('keeps regenerating after a generator replaces a watched file or its directory', async () => {
      // langium-cli writes its output by replacing each file and its directory,
      // and a watch on either would hear only the first regeneration.
      const { generated, astFile, runs } = await startWatch();
      const replace = (content: string): void => {
         writeFileSync(`${astFile}.next`, content);
         renameSync(`${astFile}.next`, astFile);
      };
      expect(runs()).toBe(1);

      replace('export const one = 1;\n');
      await vi.waitFor(() => expect(runs()).toBe(2), { timeout: 2000 });
      replace('export const two = 2;\n');
      await vi.waitFor(() => expect(runs()).toBe(3), { timeout: 2000 });

      const next = `${generated}.next`;
      mkdirSync(next);
      writeFileSync(path.join(next, 'ast.ts'), 'export const three = 3;\n');
      rmSync(generated, { recursive: true });
      renameSync(next, generated);
      await vi.waitFor(() => expect(runs()).toBe(4), { timeout: 2000 });
      replace('export const four = 4;\n');
      await vi.waitFor(() => expect(runs()).toBe(5), { timeout: 2000 });
   }, 15_000);

   it('regenerates when the directory is removed and written back at once', async () => {
      // What langium-cli does on every run, faster than any poll or event
      // round-trip: an event watch loses the recreated directory here.
      const { generated, astFile, runs } = await startWatch();
      expect(runs()).toBe(1);

      for (const content of ['export const one = 1;\n', 'export const two = 2;\n', 'export const three = 3;\n']) {
         const before = runs();
         rmSync(generated, { recursive: true });
         mkdirSync(generated);
         writeFileSync(astFile, content);
         await vi.waitFor(() => expect(runs()).toBe(before + 1), { timeout: 2000 });
      }
   }, 15_000);

   it('regenerates once a removed file is written back after the debounce', async () => {
      // langium-cli removes its output directory first and writes the files
      // afterwards; under load the gap outlasts the debounce.
      const { generated, astFile, runs } = await startWatch();
      expect(runs()).toBe(1);

      rmSync(generated, { recursive: true });
      await new Promise(resolve => setTimeout(resolve, 400));
      // Nothing runs on a half-written output.
      expect(runs()).toBe(1);
      mkdirSync(generated);
      writeFileSync(astFile, 'export const one = 1;\n');
      await vi.waitFor(() => expect(runs()).toBe(2), { timeout: 2000 });
      writeFileSync(astFile, 'export const two = 2;\n');
      await vi.waitFor(() => expect(runs()).toBe(3), { timeout: 2000 });
   }, 10_000);
});
