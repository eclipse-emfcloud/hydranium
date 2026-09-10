/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Proves `scripts/trace-exits.cjs` still records, and still keeps out of the way.
 *
 * The recorder exists for a failure whose signature is an EMPTY trace directory:
 * a Node process that npm reported as exiting non-zero, which never reached a JS
 * exit handler. A recorder that has silently stopped installing produces exactly
 * that same empty directory, and would be read as the finding. So the positive
 * cases below are not optional coverage — they are what makes "no record" mean
 * anything at all.
 *
 * The clean case is deliberately the weakest of the four and is here for a
 * different property: it would also pass against a recorder that does nothing,
 * so on its own it proves nothing. It guards the constraint that the recorder
 * writes to neither stream, which subcommand tests asserting on a spawned
 * process's exact stdout depend on.
 *
 * Each case also asserts the child's EXIT CODE is unchanged, because a preload
 * that altered one would corrupt every gate in the chain behind it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = join(REPO_ROOT, 'scripts/trace-exits.cjs');

/**
 * Each case states the shape of death it rigs and what the record must then
 * carry. `expectRecord: false` is the clean control; every other case demands a
 * record whose fields distinguish it from the others, so a recorder that wrote
 * one indiscriminate entry per process would fail rather than pass three times.
 */
const CASES = [
   {
      name: 'an uncaught exception',
      source: "throw new Error('canary-uncaught');",
      code: 1,
      expectRecord: true,
      assert: record => {
         if (record.uncaught?.message !== 'canary-uncaught') {
            return `uncaught.message is ${JSON.stringify(record.uncaught?.message)}`;
         }
         if (typeof record.uncaught.stack !== 'string' || !record.uncaught.stack.includes('canary-uncaught')) {
            return 'uncaught.stack does not carry the throw site';
         }
         return undefined;
      }
   },
   {
      name: 'an explicit process.exit with no output',
      source: 'process.exit(3);',
      code: 3,
      expectRecord: true,
      assert: record => {
         if (record.uncaught !== undefined) {
            return 'an explicit exit was recorded as an uncaught exception';
         }
         if (typeof record.exitCall !== 'string' || !record.exitCall.includes('process.exit')) {
            return `exitCall is ${JSON.stringify(record.exitCall)}`;
         }
         return undefined;
      }
   },
   {
      name: 'a deliberate process.exitCode with no output',
      source: 'process.exitCode = 4;',
      code: 4,
      expectRecord: true,
      assert: record => {
         // The discriminating case: neither field set means the tool CHOSE a
         // non-zero code, which for eslint would mean real findings whose
         // output was lost rather than a crash.
         if (record.uncaught !== undefined || record.exitCall !== undefined) {
            return 'a plain exitCode was attributed to a crash or an explicit exit';
         }
         return undefined;
      }
   },
   {
      name: 'a clean exit',
      source: "process.stdout.write('payload');",
      code: 0,
      expectRecord: false,
      stdout: 'payload'
   }
];

function runCase(testCase) {
   const traceDir = mkdtempSync(join(tmpdir(), 'hydranium-exit-trace-'));
   let stdout = '';
   let stderr = '';
   let code = 0;
   try {
      stdout = execFileSync(process.execPath, ['--require', PRELOAD, '-e', testCase.source], {
         // `NODE_OPTIONS` is CLEARED rather than inherited. Under `npm run check`
         // this process already runs with the preload in `NODE_OPTIONS`, and a
         // child inheriting it would load the recorder by two specifiers at once
         // — one record per install unless both spell the same resolved path,
         // which a symlinked checkout is free to break. Clearing it also makes
         // the case count independent of how the caller was invoked.
         env: { ...process.env, NODE_OPTIONS: '', HYDRANIUM_EXIT_TRACE_DIR: traceDir },
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'pipe']
      });
   } catch (error) {
      code = typeof error.status === 'number' ? error.status : -1;
      stdout = error.stdout ?? '';
      stderr = error.stderr ?? '';
   }

   const files = readdirSync(traceDir);
   const records = files.map(file => JSON.parse(readFileSync(join(traceDir, file), 'utf8')));
   rmSync(traceDir, { recursive: true, force: true });
   return { code, stdout, stderr, records };
}

const failures = [];
for (const testCase of CASES) {
   const result = runCase(testCase);

   if (result.code !== testCase.code) {
      failures.push(`${testCase.name}: exited ${result.code}, expected ${testCase.code} — the preload altered the code`);
      continue;
   }
   if (testCase.stdout !== undefined && result.stdout !== testCase.stdout) {
      failures.push(`${testCase.name}: stdout was ${JSON.stringify(result.stdout)}, expected ${JSON.stringify(testCase.stdout)}`);
   }
   // Only the rigged sources write anything, and none of them writes to stderr,
   // so any stderr at all is the recorder leaking into a stream a caller reads.
   if (result.stderr !== '' && !testCase.expectRecord) {
      failures.push(`${testCase.name}: the recorder wrote to stderr: ${JSON.stringify(result.stderr.slice(0, 200))}`);
   }

   if (!testCase.expectRecord) {
      if (result.records.length !== 0) {
         failures.push(`${testCase.name}: wrote ${result.records.length} record(s); a healthy process must leave none`);
      }
      continue;
   }
   if (result.records.length !== 1) {
      failures.push(`${testCase.name}: wrote ${result.records.length} record(s), expected exactly 1`);
      continue;
   }

   const [record] = result.records;
   if (record.code !== testCase.code) {
      failures.push(`${testCase.name}: record.code is ${record.code}, expected ${testCase.code}`);
   }
   const detail = testCase.assert(record);
   if (detail) {
      failures.push(`${testCase.name}: ${detail}`);
   }
}

if (failures.length > 0) {
   console.error('scripts/trace-exits.cjs no longer records what it claims:\n');
   for (const failure of failures) {
      console.error(`  - ${failure}`);
   }
   console.error('\nAn empty trace directory is itself a finding, so a recorder that has');
   console.error('stopped recording would be misread as one. Fix it or remove both files.');
   process.exit(1);
}

console.log(`✓ the exit recorder discriminates all ${CASES.length} rigged outcomes`);
