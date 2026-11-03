/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('the shared Vitest configuration prints console output from passing and failing tests', async context => {
   // guidance-claim: vitest-console-output
   const root = fileURLToPath(new URL('../', import.meta.url));
   // A fresh root makes report absence meaningful even after an interrupted run.
   // Keeping it beside the fixture preserves resolution of the installed runner.
   const probeRoot = await mkdtemp(join(root, 'scripts/fixtures/guidance-console/.probe-'));
   context.after(() => rm(probeRoot, { recursive: true, force: true }));
   await copyFile(join(root, 'scripts/fixtures/guidance-console/console.fixture.ts'), join(probeRoot, 'console.fixture.ts'));
   const result = await promisify(execFile)(
      process.execPath,
      [
         'node_modules/vitest/vitest.mjs',
         'run',
         '--config',
         join(root, 'scripts/fixtures/guidance-console/vitest.config.mts'),
         '--root',
         probeRoot
      ],
      { cwd: root, timeout: 30_000, env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' } }
   ).then(
      value => ({ ...value, code: 0 }),
      (error: { code: number; stdout: string; stderr: string }) => error
   );
   const output = result.stdout + result.stderr;
   assert.equal(result.code, 1, output);
   for (const marker of ['GUIDANCE_PASS_CONSOLE', 'GUIDANCE_FAIL_CONSOLE', 'GUIDANCE_PASS_STDERR', 'GUIDANCE_FAIL_STDERR']) {
      assert.ok(output.includes(marker), `missing ${marker}:\n${output}`);
   }
   assert.match(output, /1 failed.*1 passed/);
   await assert.rejects(
      stat(join(probeRoot, 'test-results/junit.xml')),
      { code: 'ENOENT' },
      'the deliberate failure must not enter CI summaries'
   );
});
