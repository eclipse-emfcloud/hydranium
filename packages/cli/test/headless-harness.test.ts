/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the headless-harness subcommands (`measure-memory`,
 * `ast-ground-truth`). The actual harness run boots a head's services and builds
 * a workspace in a spawned child. Here we inject `__spawnForTest` to assert the
 * parent wires the correct driver path, node exec flags, and forwarded options
 * without spawning anything.
 */

import { DEFAULT_LOG_LEVEL_ENV } from '@hydranium/protocol';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildDriverArgs, runMeasureMemory } from '../src/commands/measure-memory.js';
import { buildGroundTruthDriverArgs, runAstGroundTruth } from '../src/commands/ast-ground-truth.js';
import { emitReport, type DriverSpawnOptions } from '../src/commands/headless-harness.js';
import { runLintGrammar } from '../src/commands/lint-grammar.js';
import { runModelDocs } from '../src/commands/model-docs.js';
import { runReflect } from '../src/commands/reflect.js';
import { runValidate } from '../src/commands/validate.js';

describe('measure-memory', () => {
   it('buildDriverArgs: emits --services + workspace and omits unset options', () => {
      expect(buildDriverArgs({ servicesModule: './svc.js', workspace: '/ws' })).toEqual(['--services', './svc.js', '/ws']);
   });

   it('buildDriverArgs: forwards every set option in the order the driver parses', () => {
      expect(
         buildDriverArgs({
            servicesModule: './svc.js',
            workspace: '/ws',
            editCycles: 5,
            editDocs: 10,
            churnSuffix: '.demo',
            writeSnapshot: true,
            snapshotPath: '/tmp/x.heapsnapshot'
         })
      ).toEqual([
         '--services',
         './svc.js',
         '/ws',
         '--edits',
         '5',
         '--edit-docs',
         '10',
         '--churn-suffix',
         '.demo',
         '--snapshot',
         '--snapshot-path',
         '/tmp/x.heapsnapshot'
      ]);
   });

   it('buildDriverArgs: omits --snapshot when writeSnapshot is false', () => {
      expect(buildDriverArgs({ servicesModule: './svc.js', workspace: '/ws', writeSnapshot: false })).not.toContain('--snapshot');
   });

   it('runMeasureMemory: spawns the driver under --expose-gc with the forwarded args', async () => {
      let captured: string[] = [];
      await runMeasureMemory({
         servicesModule: './svc.js',
         workspace: '/ws',
         editCycles: 3,
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured[0]).toBe('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('measure-memory-driver.js'))).toBe(true);
      expect(captured.slice(-5)).toEqual(['--services', './svc.js', '/ws', '--edits', '3']);
   });

   it('runMeasureMemory: a non-zero child exit sets the process exit code', async () => {
      const previous = process.exitCode;
      await runMeasureMemory({ servicesModule: './svc.js', workspace: '/ws', __spawnForTest: () => Promise.resolve(2) });
      expect(process.exitCode).toBe(2);
      process.exitCode = previous;
   });
});

describe('ast-ground-truth', () => {
   it('buildGroundTruthDriverArgs: emits --services + workspace, adds --out-file when set', () => {
      expect(buildGroundTruthDriverArgs({ servicesModule: './svc.js', workspace: '/ws' })).toEqual(['--services', './svc.js', '/ws']);
      expect(buildGroundTruthDriverArgs({ servicesModule: './svc.js', workspace: '/ws', outFile: '/tmp/gt.json' })).toEqual([
         '--services',
         './svc.js',
         '/ws',
         '--out-file',
         '/tmp/gt.json'
      ]);
   });

   it('runAstGroundTruth: spawns the driver (no --expose-gc) with the forwarded args', async () => {
      let captured: string[] = [];
      await runAstGroundTruth({
         servicesModule: './svc.js',
         workspace: '/ws',
         outFile: '/tmp/gt.json',
         __spawnForTest: execArgs => {
            captured = execArgs;
            return Promise.resolve(0);
         }
      });
      expect(captured).not.toContain('--expose-gc');
      expect(captured).toContain('--max-old-space-size=8192');
      expect(captured.some(arg => arg.endsWith('ast-ground-truth-driver.js'))).toBe(true);
      expect(captured.slice(-5)).toEqual(['--services', './svc.js', '/ws', '--out-file', '/tmp/gt.json']);
   });
});

/**
 * Where the verbosity flag actually lands, asserted over the SET of six parents.
 *
 * The threshold reaches the head through the child's ENVIRONMENT and not its
 * argv, because the head's logger reads it while `createServices` constructs it —
 * inside the driver's dynamic import. So a parent that forwarded the flag onto
 * the driver argv instead would parse cleanly, run, and change nothing, and an
 * argv assertion could not tell the two apart. The set is the assertion: a parent
 * that stops going through the shared spawn helper loses the flag with nothing to
 * report, which no per-command test that nobody added can see.
 */
describe('the log threshold reaches the driver child', () => {
   const PARENTS: ReadonlyArray<{
      name: string;
      run: (options: DriverSpawnOptions & { servicesModule: string; workspace: string }) => Promise<void>;
   }> = [
      { name: 'ast-ground-truth', run: runAstGroundTruth },
      { name: 'lint-grammar', run: runLintGrammar },
      { name: 'measure-memory', run: runMeasureMemory },
      { name: 'model-docs', run: runModelDocs },
      { name: 'reflect', run: runReflect },
      { name: 'validate', run: runValidate }
   ];

   it('covers the six of them, so no assertion below runs on a short list', () => {
      expect(PARENTS.map(parent => parent.name)).toEqual([
         'ast-ground-truth',
         'lint-grammar',
         'measure-memory',
         'model-docs',
         'reflect',
         'validate'
      ]);
   });

   it.each(PARENTS)('$name: sets the log-level variable on the child env, and only that', async ({ run }) => {
      let captured: Record<string, string> | undefined;
      let argv: string[] = [];
      await run({
         servicesModule: './svc.js',
         workspace: '/ws',
         logLevel: 'trace',
         __spawnForTest: (execArgs, env) => {
            argv = execArgs;
            captured = env;
            return Promise.resolve(0);
         }
      });

      expect(captured).toEqual({ [DEFAULT_LOG_LEVEL_ENV]: 'trace' });
      // Not on the argv too: the driver has no such flag, so a forwarded one
      // would be rejected as unknown by the child that must not see it.
      expect(argv).not.toContain('--log-level');
   });

   it.each(PARENTS)('$name: leaves the child env alone when no level was asked for', async ({ run }) => {
      // `undefined` rather than `{}`: the spawn helper reads the difference as
      // "inherit the parent's environment", which is what keeps an ambient
      // HYDRANIUM_LOG_LEVEL working.
      let captured: Record<string, string> | undefined | 'unset' = 'unset';
      await run({
         servicesModule: './svc.js',
         workspace: '/ws',
         __spawnForTest: (_execArgs, env) => {
            captured = env;
            return Promise.resolve(0);
         }
      });

      expect(captured).toBeUndefined();
   });
});

/**
 * The shared `--out-file` delivery every report-producing driver funnels through.
 *
 * Worth its own tier: the drivers themselves run `main()` on import and can only
 * be spawned, so this is the only place the two branches — file versus stdout —
 * are observable without a child process.
 */
describe('emitReport', () => {
   const scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-emit-report-'));

   afterEach(() => {
      vi.restoreAllMocks();
   });

   afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
   });

   it('writes the report to the named file and keeps it off stdout', () => {
      const target = path.join(scratch, 'report.md');
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      emitReport('# Report', target);

      expect(readFileSync(target, 'utf-8')).toBe('# Report\n');
      // Off stdout entirely, not merely "also written": a caller that redirects
      // stdout into a second artefact must not receive the report twice.
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(`Wrote ${target}`);
   });

   it('falls back to stdout when no file is named, writing nothing to disk', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const before = readdirSync(scratch);

      emitReport('# Report', undefined);

      expect(log).toHaveBeenCalledWith('# Report');
      // An absent destination must mean stdout, not a file under some default
      // name that the caller never asked for and would never look for.
      expect(readdirSync(scratch)).toEqual(before);
   });

   it('terminates the file with exactly one newline, however the report ended', () => {
      // A report already ending in a newline must not gain a blank last line: the
      // Markdown ones do end that way and the JSON ones do not, and both land here.
      const ended = path.join(scratch, 'ended.md');
      const bare = path.join(scratch, 'bare.md');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      emitReport('body\n', ended);
      emitReport('body', bare);

      expect(readFileSync(ended, 'utf-8')).toBe('body\n');
      expect(readFileSync(bare, 'utf-8')).toBe('body\n');
   });
});
