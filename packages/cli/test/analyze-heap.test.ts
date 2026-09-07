/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalyzeHeapCommand } from '../src/commands/analyze-heap-args.js';
import { runAnalyzeHeap } from '../src/commands/analyze-heap.js';

describe('runAnalyzeHeap', () => {
   const priorExitCode = process.exitCode;
   afterEach(() => {
      process.exitCode = priorExitCode;
   });

   it('forwards args verbatim to the analyzer child behind the heap flag', async () => {
      const calls: string[][] = [];
      await runAnalyzeHeap(['snapshot.heapsnapshot', '--renderer', '--top-concepts', '5'], {
         __memlabInstalledForTest: () => true,
         __spawnForTest: async execArgs => {
            calls.push(execArgs);
            return 0;
         }
      });
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('--max-old-space-size=8192');
      expect(calls[0][1]).toMatch(/analyze-heap\.mjs$/); // the bundled analyzer path
      expect(calls[0].slice(2)).toEqual(['snapshot.heapsnapshot', '--renderer', '--top-concepts', '5']);
   });

   it('propagates a non-zero analyzer exit code', async () => {
      await runAnalyzeHeap(['x.heapsnapshot'], {
         __memlabInstalledForTest: () => true,
         __spawnForTest: async () => 3
      });
      expect(process.exitCode).toBe(3);
   });

   it('does not spawn and exits non-zero when memlab is not installed', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let spawned = false;
      await runAnalyzeHeap(['x.heapsnapshot'], {
         __memlabInstalledForTest: () => false,
         __spawnForTest: async () => {
            spawned = true;
            return 0;
         }
      });
      expect(spawned).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('@memlab/heap-analysis'));
      errorSpy.mockRestore();
   });

   it('runs --diff without memlab, which that path never imports', async () => {
      const calls: string[][] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await runAnalyzeHeap(['--diff', 'base.json', 'cur.json'], {
         __memlabInstalledForTest: () => false,
         __spawnForTest: async execArgs => {
            calls.push(execArgs);
            return 0;
         }
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].slice(2)).toEqual(['--diff', 'base.json', 'cur.json']);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
   });
});

describe('runAnalyzeHeapCommand', () => {
   const priorExitCode = process.exitCode;
   afterEach(() => {
      process.exitCode = priorExitCode;
   });

   /** Refuse the spawn outright: every case here must answer before the analyzer runs. */
   function refuseSpawn(): { readonly __spawnForTest: (execArgs: string[]) => Promise<number>; readonly spawned: () => boolean } {
      let spawned = false;
      return {
         __spawnForTest: async () => {
            spawned = true;
            return 0;
         },
         spawned: () => spawned
      };
   }

   it('prints its help without the optional dependency, and without spawning', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const spawn = refuseSpawn();
      await runAnalyzeHeapCommand(['--help'], { __memlabInstalledForTest: () => false, __spawnForTest: spawn.__spawnForTest });

      expect(spawn.spawned()).toBe(false);
      expect(process.exitCode).toBe(priorExitCode);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^Usage: hydranium-cli analyze-heap/));
      logSpy.mockRestore();
   });

   it('with no arguments prints usage and exits non-zero, matching the parent binary', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const spawn = refuseSpawn();
      await runAnalyzeHeapCommand([], { __memlabInstalledForTest: () => true, __spawnForTest: spawn.__spawnForTest });

      expect(spawn.spawned()).toBe(false);
      // 1, not 0: a CI step that forgot its snapshot argument must fail rather
      // than read a help page as a completed analysis.
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^Usage: hydranium-cli analyze-heap/));
      logSpy.mockRestore();
   });
});
