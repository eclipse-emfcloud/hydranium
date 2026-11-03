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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('the shared Vitest configuration prints console output from passing and failing tests', async () => {
   // guidance-claim: vitest-console-output
   const root = fileURLToPath(new URL('../', import.meta.url));
   const result = await promisify(execFile)(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/fixtures/guidance-console/vitest.config.mts'],
      { cwd: root, timeout: 30_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }
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
});
