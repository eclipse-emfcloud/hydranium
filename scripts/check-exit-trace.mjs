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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// The FALLBACK route, exercised against a COPY of the preload so the repo's own
// `exit-trace` directory is neither created nor polluted by the test. Both
// halves matter and the negative one matters more: a fallback that armed itself
// wherever the preload happened to sit would record on every developer machine.
{
   const scratch = mkdtempSync(join(tmpdir(), 'hydranium-fallback-'));
   try {
      mkdirSync(join(scratch, 'scripts'), { recursive: true });
      const copiedPreload = join(scratch, 'scripts/trace-exits.cjs');
      copyFileSync(PRELOAD, copiedPreload);
      const environment = { ...process.env, NODE_OPTIONS: '' };
      delete environment.HYDRANIUM_EXIT_TRACE_DIR;

      const die = () => {
         try {
            execFileSync(process.execPath, ['--require', copiedPreload, '-e', 'process.exit(5)'], {
               env: environment,
               stdio: ['ignore', 'pipe', 'pipe']
            });
         } catch {
            // The rigged exit; the assertion is on what it left behind.
         }
      };

      die();
      if (existsSync(join(scratch, 'exit-trace'))) {
         failures.push('the fallback CREATED its directory, so the recorder arms itself wherever the preload sits');
      }

      mkdirSync(join(scratch, 'exit-trace'));
      die();
      if (readdirSync(join(scratch, 'exit-trace')).length !== 1) {
         failures.push('with no environment variable and an existing exit-trace/, the fallback recorded nothing');
      }
   } catch (error) {
      failures.push(`could not exercise the fallback route: ${String(error.message ?? error).slice(0, 200)}`);
   } finally {
      rmSync(scratch, { recursive: true, force: true });
   }
}

// DELIVERY, which is a separate property from recording and is the one that
// actually failed in the field. Every case above reaches the preload by an
// explicit `--require` and an explicit environment, so all four passed on a run
// where the recorder was inert for every process that mattered: turbo 2's strict
// environment mode had dropped `HYDRANIUM_EXIT_TRACE_DIR`, and nothing here ran
// under turbo. These two cases are the ones that would have caught it.
const TURBO = join(REPO_ROOT, 'node_modules/.bin/turbo');

// That turbo can PARSE the real file. Nothing else here does: the probe below
// builds a scratch config from one value, and `JSON.parse` accepts keys turbo's
// schema rejects — a `"//key"` comment among them, which takes down every task
// in the repository rather than only this feature. `--dry` validates without
// executing.
try {
   execFileSync(TURBO, ['run', 'build', '--dry=json'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
   const detail = String(error.stderr || error.stdout || error.message || error);
   failures.push(`turbo cannot parse turbo.json: ${detail.replace(/\s+/g, ' ').slice(0, 300)}`);
}

// turbo.json is JSONC. Only WHOLE-line comments are stripped: a blanket `//`
// strip would cut the `$schema` URL in half, and the truncated value would still
// parse.
const REPO_TURBO_CONFIG = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

// The declaration, read from the real config rather than a copy of it, because
// deleting the line is the cheap way for this to regress.
if (!(REPO_TURBO_CONFIG.globalPassThroughEnv ?? []).includes('HYDRANIUM_EXIT_TRACE_DIR')) {
   failures.push('turbo.json no longer declares HYDRANIUM_EXIT_TRACE_DIR in globalPassThroughEnv, so turbo drops it');
}

// And that turbo HONOURS the declaration, run against a scratch workspace
// carrying this repo's own `globalPassThroughEnv`. Asserting the config alone
// would not have caught turbo changing what strict mode means.
{
   const scratch = mkdtempSync(join(tmpdir(), 'hydranium-turbo-env-'));
   try {
      mkdirSync(join(scratch, 'pkgs/probe'), { recursive: true });
      writeFileSync(
         join(scratch, 'package.json'),
         JSON.stringify({ name: 'probe-root', private: true, version: '0.0.0', packageManager: 'npm@0.0.0', workspaces: ['pkgs/*'] })
      );
      writeFileSync(
         join(scratch, 'turbo.json'),
         JSON.stringify({
            globalPassThroughEnv: REPO_TURBO_CONFIG.globalPassThroughEnv,
            tasks: { probe: { cache: false } }
         })
      );
      writeFileSync(
         join(scratch, 'pkgs/probe/package.json'),
         JSON.stringify({
            name: 'probe',
            version: '0.0.0',
            scripts: { probe: 'node -e "process.stdout.write(String(process.env.HYDRANIUM_EXIT_TRACE_DIR))"' }
         })
      );
      const stdout = execFileSync(TURBO, ['run', 'probe', '--ui=stream'], {
         cwd: scratch,
         encoding: 'utf8',
         env: { ...process.env, HYDRANIUM_EXIT_TRACE_DIR: 'DELIVERED' },
         stdio: ['ignore', 'pipe', 'pipe']
      });
      if (!stdout.includes('DELIVERED')) {
         failures.push('a turbo task did not receive HYDRANIUM_EXIT_TRACE_DIR, so the recorder is inert inside turbo');
      }
   } catch (error) {
      failures.push(`could not ask turbo what a task receives: ${String(error.message ?? error).slice(0, 200)}`);
   } finally {
      rmSync(scratch, { recursive: true, force: true });
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

console.log(`✓ the exit recorder discriminates all ${CASES.length} rigged outcomes, and reaches a turbo task by both routes`);
