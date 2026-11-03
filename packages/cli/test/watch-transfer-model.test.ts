/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchTransferModel } from '../src/commands/generate-transfer-model.js';

vi.mock('fs', async importOriginal => ({ ...(await importOriginal<typeof fs>()) }));

function observeWatch() {
   return vi.spyOn(
      fs as {
         watchFile(
            file: fs.PathLike,
            options: { interval: number },
            listener: (current: fs.Stats, previous: fs.Stats) => void
         ): fs.StatWatcher;
      },
      'watchFile'
   );
}

describe('watchTransferModel', () => {
   let scratch: string | undefined;
   let controller: AbortController | undefined;

   afterEach(() => {
      controller?.abort();
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (scratch !== undefined) {
         rmSync(scratch, { recursive: true, force: true });
      }
   });

   function fixture() {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-watch-transfer-'));
      const options = {
         astFile: path.join(scratch, 'ast.ts'),
         augmentationFile: path.join(scratch, 'augmentation.ts'),
         outFile: path.join(scratch, 'out.ts')
      };
      const source = (property: string) => `
         export interface Element { readonly $type: 'Element'; ${property}: string; }
         export class ExampleAstReflection extends AbstractAstReflection {
            readonly types = { Element: { name: 'Element', superTypes: [], properties: {} } };
         }
      `;
      writeFileSync(options.astFile, source('one'));
      writeFileSync(options.augmentationFile, 'export {};');
      controller = new AbortController();
      const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runs = () =>
         logs.mock.calls.filter(([message]) => message === `Generated: ${options.outFile}` || message === 'Transfer model is up to date.')
            .length;
      return { options, source, logs, errors, runs, signal: controller.signal };
   }

   it('resolves an already aborted signal without generating or registering watchers', async () => {
      const { options, signal, runs } = fixture();
      controller!.abort();
      const watch = observeWatch();
      const stopped = watchTransferModel(options, { signal });
      expect(watch).not.toHaveBeenCalled();
      expect(runs()).toBe(0);
      await stopped;
   });

   it('regenerates real output after either input changes and recovers from a generation error', async () => {
      const { options, source, signal, errors, runs } = fixture();
      const watch = observeWatch();
      const stopped = watchTransferModel(options, { signal });
      expect(readFileSync(options.outFile, 'utf8')).toContain('one: string;');
      // A missing file followed by its return also establishes the polling
      // baseline before the subsequent edits on platforms with delayed stats.
      const listener = watch.mock.calls[0][2]!;
      const missing = new Promise<void>(resolve => watch.mock.results[0].value.once('change', () => resolve()));
      rmSync(options.astFile);
      await missing;
      const returned = new Promise<number>(resolve => watch.mock.results[0].value.once('change', () => resolve(runs())));
      writeFileSync(options.astFile, source('second'));
      const beforeReturn = await returned;
      await vi.waitFor(() => expect(runs()).toBeGreaterThan(beforeReturn), { timeout: 5000 });
      await vi.waitFor(() => expect(readFileSync(options.outFile, 'utf8')).toContain('second: string;'), { timeout: 5000 });
      writeFileSync(options.augmentationFile, "declare module './ast.js' { interface Element { extra: number; } }");
      await vi.waitFor(() => expect(readFileSync(options.outFile, 'utf8')).toContain('extra: number;'), { timeout: 5000 });
      writeFileSync(options.astFile, 'export {};');
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('Transfer-model generation failed:')), {
         timeout: 5000
      });
      writeFileSync(options.astFile, source('recovered'));
      await vi.waitFor(() => expect(readFileSync(options.outFile, 'utf8')).toContain('recovered: string;'), { timeout: 5000 });
      const unwatch = vi.spyOn(fs, 'unwatchFile');
      controller!.abort();
      await stopped;
      expect(unwatch.mock.calls).toEqual([
         [options.astFile, listener],
         [options.augmentationFile, listener]
      ]);
   }, 15_000);

   it('debounces successive changes and cancels a pending generation on abort', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { options, source, signal, runs } = fixture();
      const watch = observeWatch();
      const stopped = watchTransferModel(options, { signal });
      const poll = watch.mock.calls[0][2]!;
      const previous = fs.statSync(options.astFile);
      writeFileSync(options.astFile, source('second'));
      poll(fs.statSync(options.astFile), previous);
      vi.advanceTimersByTime(100);
      writeFileSync(options.augmentationFile, "declare module './ast.js' { interface Element { extra: number; } }");
      poll(fs.statSync(options.augmentationFile), previous);
      vi.advanceTimersByTime(100);
      expect(runs()).toBe(1);
      vi.advanceTimersByTime(50);
      expect(runs()).toBe(2);
      expect(readFileSync(options.outFile, 'utf8')).toContain('extra: number;');
      vi.advanceTimersByTime(1000);
      expect(runs()).toBe(2);
      writeFileSync(options.astFile, source('cancelled'));
      poll(fs.statSync(options.astFile), previous);
      controller!.abort();
      vi.advanceTimersByTime(1000);
      expect(runs()).toBe(2);
      await stopped;
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
