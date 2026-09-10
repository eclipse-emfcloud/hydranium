/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Decides whether a red gate is the known Windows silent-exit flake or a real
 * failure, so CI can quarantine the first without hiding the second.
 *
 * Every condition must hold. The load-bearing one is that the task passed on
 * RE-RUN: a real failure reproduces. The shape checks are narrow on purpose —
 * "wrote nothing" alone would also match a buffering tool or a killed process
 * group, so only the two presentations actually observed are accepted.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Built from a char code rather than written as an escape: `no-control-regex`
// rejects the literal, and turbo colours everything this reads.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = text => text.replace(ANSI, '');

/** The tasks turbo reported as failed, in the order it printed them. */
export function failedTasks(gateLog) {
   return stripAnsi(gateLog)
      .split('\n')
      .flatMap(line => {
         const match = /^Failed:\s+(\S+)/.exec(line.trim());
         return match ? [match[1]] : [];
      });
}

/**
 * `@scope/name#script` → the path of the turbo log that task wrote. turbo spells
 * `:` as `$colon$`, and `typecheck:test` is one of the scripts the flake kills,
 * so the naive spelling misses exactly the case that matters.
 */
export function taskLogPath(packageDirs, task) {
   const [packageName, script] = task.split('#');
   const directory = packageDirs.get(packageName);
   if (!directory || !script) {
      return undefined;
   }
   return join(directory, '.turbo', `turbo-${script.replaceAll(':', '$colon$')}.log`);
}

/**
 * The two presentations, as predicates over the failed task's own log. Returns a
 * reason rather than a boolean so the summary names WHICH shape matched;
 * whether the two are one mechanism is still open.
 */
export function matchPresentation(taskLog) {
   const text = stripAnsi(taskLog);

   // The worker-error line alone is not enough: a suite can lose a worker AND
   // have real failures, and that is a red.
   if (text.includes('Worker exited unexpectedly')) {
      if (/Test Files.*\bfailed\b/.test(text) || /Tests\s+.*\bfailed\b/.test(text)) {
         return { flake: false, reason: 'a worker died and tests also failed' };
      }
      return { flake: true, reason: 'a vitest worker exited with every test that ran passing' };
   }

   // What a silent tool leaves is npm's banner and error block. Anything else —
   // a diagnostic, a stack, a lint finding — means the tool spoke, and a tool
   // that spoke has a real failure to report.
   const spoke = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !line.startsWith('npm error'))
      .filter(line => !line.startsWith('>'))
      .filter(line => !line.startsWith('cache miss') && !line.startsWith('cache hit'))
      .filter(line => !line.startsWith('::group::') && !line.startsWith('::endgroup::'))
      .filter(line => !/^@?[\w./@-]+:[\w:-]+$/.test(line));
   if (spoke.length === 0) {
      return { flake: true, reason: 'a tool exited non-zero having written nothing' };
   }
   return { flake: false, reason: `the task wrote ${spoke.length} line(s) of its own` };
}

/**
 * @param {{ gateLog: string, rerunStatus: number|undefined, readTaskLog: (task: string) => string|undefined }} inputs
 */
export function classify({ gateLog, rerunStatus, readTaskLog }) {
   const tasks = failedTasks(gateLog);
   if (tasks.length === 0) {
      return { quarantine: false, why: 'the gate failed with no turbo task named, so this is not the flake' };
   }
   if (tasks.length > 1) {
      return { quarantine: false, why: `${tasks.length} tasks failed; the flake takes exactly one` };
   }
   const [task] = tasks;

   const taskLog = readTaskLog(task);
   if (taskLog === undefined) {
      return { quarantine: false, why: `no turbo log was captured for ${task}, so its shape cannot be checked` };
   }
   const presentation = matchPresentation(taskLog);
   if (!presentation.flake) {
      return { quarantine: false, why: `${task} does not match the flake: ${presentation.reason}` };
   }

   // A re-run that was not attempted is NOT a pass.
   if (rerunStatus !== 0) {
      return {
         quarantine: false,
         why: `${task} matched the flake's shape but its re-run ${rerunStatus === undefined ? 'did not run' : `exited ${rerunStatus}`}`
      };
   }
   return { quarantine: true, task, why: `${task}: ${presentation.reason}, and it passed on re-run` };
}

/** Workspace package name → directory, read from the manifests turbo itself uses. */
function workspacePackageDirs(root) {
   const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
   const dirs = new Map();
   for (const entry of manifest.workspaces ?? []) {
      const candidates = entry.includes('*')
         ? execFileSync('git', ['-C', root, 'ls-files', '--full-name', entry.replace('*', '') + '*/package.json'], { encoding: 'utf8' })
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(path => dirname(path))
         : [entry];
      for (const candidate of candidates) {
         const packageJson = join(root, candidate, 'package.json');
         if (existsSync(packageJson)) {
            dirs.set(JSON.parse(readFileSync(packageJson, 'utf8')).name, join(root, candidate));
         }
      }
   }
   return dirs;
}

function selfTest() {
   const failures = [];
   const check = (name, actual, expected) => {
      if (actual !== expected) {
         failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
   };

   const WORKER_FLAKE = [
      '> @hydranium/core@1.0.0-next test',
      '> npm run typecheck:test && vitest run',
      ' ✓ core test/a.test.ts (3 tests) 12ms',
      'Caused by: Error: Worker exited unexpectedly [hydranium-patch] code=1 hex=0x00000001 signal=null',
      ' Test Files  111 passed (112)',
      '      Tests  1655 passed | 1 skipped (1656)',
      '     Errors  1 error'
   ].join('\n');

   const WORKER_PLUS_REAL_FAILURE = WORKER_FLAKE.replace('Test Files  111 passed (112)', 'Test Files  1 failed | 110 passed (112)');

   const SILENT_TOOL = [
      '> @hydranium/example-bookstore-server@0.0.0 test',
      '> npm run typecheck:test && vitest run',
      '',
      '> @hydranium/example-bookstore-server@0.0.0 typecheck:test',
      '> tsc --noEmit -p tsconfig.test.json',
      '',
      'npm error Lifecycle script `typecheck:test` failed with error:',
      'npm error code 1'
   ].join('\n');

   const TOOL_THAT_SPOKE = SILENT_TOOL.replace(
      '> tsc --noEmit -p tsconfig.test.json',
      '> tsc --noEmit -p tsconfig.test.json\nsrc/x.ts(3,1): error TS2322: Type mismatch.'
   );

   const gate = task => `Tasks:    47 successful, 65 total\nFailed:    ${task}\n`;

   check(
      'a worker flake quarantines',
      classify({ gateLog: gate('a#test'), rerunStatus: 0, readTaskLog: () => WORKER_FLAKE }).quarantine,
      true
   );
   check(
      'a silent tool quarantines',
      classify({ gateLog: gate('a#test'), rerunStatus: 0, readTaskLog: () => SILENT_TOOL }).quarantine,
      true
   );
   check(
      'a worker death beside real test failures does not',
      classify({ gateLog: gate('a#test'), rerunStatus: 0, readTaskLog: () => WORKER_PLUS_REAL_FAILURE }).quarantine,
      false
   );
   check(
      'a tool that printed a diagnostic does not',
      classify({ gateLog: gate('a#test'), rerunStatus: 0, readTaskLog: () => TOOL_THAT_SPOKE }).quarantine,
      false
   );
   check(
      'a reproducing failure does not',
      classify({ gateLog: gate('a#test'), rerunStatus: 1, readTaskLog: () => WORKER_FLAKE }).quarantine,
      false
   );
   check(
      'a re-run that never happened does not',
      classify({ gateLog: gate('a#test'), rerunStatus: undefined, readTaskLog: () => WORKER_FLAKE }).quarantine,
      false
   );
   check(
      'two failed tasks do not',
      classify({ gateLog: `Failed:    a#test\nFailed:    b#lint\n`, rerunStatus: 0, readTaskLog: () => WORKER_FLAKE }).quarantine,
      false
   );
   check(
      'a gate naming no task does not',
      classify({ gateLog: 'boom', rerunStatus: 0, readTaskLog: () => WORKER_FLAKE }).quarantine,
      false
   );
   check(
      'a task whose log was not captured does not',
      classify({ gateLog: gate('a#test'), rerunStatus: 0, readTaskLog: () => undefined }).quarantine,
      false
   );

   // The `$colon$` spelling is the one turbo actually writes, and getting it
   // wrong would silently classify every `typecheck:test` failure as
   // uncapturable rather than as the flake.
   const scratch = mkdtempSync(join(tmpdir(), 'hydranium-classify-'));
   try {
      writeFileSync(join(scratch, 'package.json'), JSON.stringify({ workspaces: [] }));
      const dirs = new Map([['@x/y', '/pkg']]);
      check(
         'a colon in the script name maps to turbo s filename',
         taskLogPath(dirs, '@x/y#typecheck:test'),
         join('/pkg', '.turbo', 'turbo-typecheck$colon$test.log')
      );
      check('a plain script name maps straight through', taskLogPath(dirs, '@x/y#test'), join('/pkg', '.turbo', 'turbo-test.log'));
   } finally {
      rmSync(scratch, { recursive: true, force: true });
   }

   if (failures.length > 0) {
      console.error('classify-gate-failure self-test failed:\n');
      for (const failure of failures) {
         console.error(`  - ${failure}`);
      }
      process.exit(1);
   }
   console.log('✓ the flake classifier accepts both presentations and refuses seven near-misses');
}

// Guarded, because the self-test imports these functions and a module that ran
// its CI branch on import would classify the developer's own tree.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly && process.argv.includes('--self-test')) {
   selfTest();
} else if (invokedDirectly) {
   const gateLogPath = join(REPO_ROOT, 'gate.log');
   if (!existsSync(gateLogPath)) {
      console.log('quarantine=false');
      console.log('- verdict: no gate.log, so there is nothing to classify');
      process.exit(0);
   }
   const rerunStatusRaw = process.env.HYDRANIUM_RERUN_STATUS;
   const packageDirs = workspacePackageDirs(REPO_ROOT);
   const verdict = classify({
      gateLog: readFileSync(gateLogPath, 'utf8'),
      rerunStatus: rerunStatusRaw === undefined || rerunStatusRaw === '' ? undefined : Number(rerunStatusRaw),
      readTaskLog: task => {
         const path = taskLogPath(packageDirs, task);
         return path && existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      }
   });

   const report = [`- verdict: \`${verdict.quarantine ? 'known flake' : 'real failure'}\` — ${verdict.why}`];
   console.log(`quarantine=${verdict.quarantine}`);
   for (const line of report) {
      console.log(line.replaceAll('`', ''));
   }
   if (process.env.GITHUB_OUTPUT) {
      appendToFile(process.env.GITHUB_OUTPUT, `quarantine=${verdict.quarantine}\n`);
   }
   if (process.env.GITHUB_STEP_SUMMARY) {
      appendToFile(process.env.GITHUB_STEP_SUMMARY, `${['### Gate failure', ...report].join('\n')}\n`);
   }
}

function appendToFile(path, text) {
   writeFileSync(path, text, { flag: 'a' });
}
