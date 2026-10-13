/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DEFAULT_CPU_PROFILE_FILE_ENV, Deferred } from '@hydranium/protocol';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
   captureServerLog,
   DEFAULT_SERVER_CPU_PROFILE_ENV,
   DEFAULT_SERVER_LOG_DIR_ENV
} from '../../src/testing/playwright/server-log-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The child runs the BUILT entry, since a plain `node` child cannot load TypeScript. */
const NODE_ENTRY = pathToFileURL(path.resolve(HERE, '../../lib/node/index.js')).href;
const LOGGER_MODULE = pathToFileURL(path.resolve(HERE, '../../lib/langium/diagnostics/logger.js')).href;

/** A cold child loads the whole `./node` entry, which takes seconds on a loaded CI machine. */
const CHILD_TIMEOUT_MS = 60_000;

/**
 * The child: load the entry (which starts the profile when the variable is
 * set), supply the `{workspace}` value unless told not to, run the mode's extra
 * setup, burn some CPU, report readiness with its SIGTERM listener count, and
 * exit with code 0 on any stdin input. The `adopter-once-first` mode registers
 * an async `once` shutdown before the entry loads, as a host's own bootstrap may.
 * The `second-copy` mode loads the profiler module a second time under another
 * URL, which is what a second installed copy of the package amounts to.
 */
const CHILD_SOURCE = `
const [nodeEntry, loggerModule, mode, windowDir] = process.argv.slice(1);
if (mode === 'adopter-once-first') process.once('SIGTERM', () => setTimeout(() => process.exit(9), 100));
const { ProfileCapture } = await import(nodeEntry);
if (mode === 'second-copy') {
   const copy = await import(new URL('./startup-cpu-profile.js?copy=2', nodeEntry).href);
   copy.startCpuProfileFromEnv();
}
const { resolveLogFilePlaceholder } = await import(loggerModule);
const busy = ms => { const until = Date.now() + ms; let sum = 0; while (Date.now() < until) sum += Math.sqrt(sum + 1); return sum; };
if (mode !== 'unresolved') resolveLogFilePlaceholder('workspace', 'ws-token');
let terms = 0;
if (mode === 'other-listener') process.on('SIGTERM', () => { terms++; setTimeout(() => process.exit(6 + terms), 100); });
if (mode === 'window') {
   const capture = await ProfileCapture.start({ cpu: true });
   busy(100);
   await capture.stop(windowDir, 'window');
}
if (mode === 'worker') {
   const { Worker } = await import('node:worker_threads');
   // The worker reports how many exit listeners loading the entry added there.
   const source = 'const before = process.listenerCount("exit"); import(' + JSON.stringify(nodeEntry) + ')'
      + '.then(() => import("node:worker_threads")).then(wt => wt.parentPort.postMessage(process.listenerCount("exit") - before));';
   const worker = new Worker(source, { eval: true });
   const added = await new Promise(resolve => worker.once('message', resolve));
   await worker.terminate();
   process.stdout.write('worker-exit-listeners-added ' + added + '\\n');
}
busy(50);
process.stdin.on('data', () => process.exit(0));
process.stdout.write('ready ' + process.listenerCount('SIGTERM') + '\\n');
`;

type ChildMode = 'plain' | 'unresolved' | 'other-listener' | 'adopter-once-first' | 'second-copy' | 'window' | 'worker';

interface ChildEnd {
   readonly code: number | null;
   readonly signal: NodeJS.Signals | null;
}

interface ProfiledChild {
   readonly pid: number | undefined;
   /** Resolves with the child's SIGTERM listener count once it is set up. */
   readonly ready: Promise<number>;
   readonly ended: Promise<ChildEnd>;
   stdout(): string;
   stderr(): string;
   /** Ask the child to call `process.exit(0)`. */
   exit(): void;
   kill(signal: NodeJS.Signals): void;
}

function restoreEnv(name: string, value: string | undefined): void {
   if (value === undefined) {
      delete process.env[name];
   } else {
      process.env[name] = value;
   }
}

let dir: string;
/** Children not yet ended, killed after each case so a hung one cannot outlive it. */
const running = new Set<ChildProcess>();

beforeEach(() => {
   dir = mkdtempSync(path.join(tmpdir(), 'startup-cpu-profile-'));
});

afterEach(() => {
   for (const child of running) {
      child.kill('SIGKILL');
   }
   running.clear();
   rmSync(dir, { recursive: true, force: true });
});

function startChild(mode: ChildMode, env: NodeJS.ProcessEnv): ProfiledChild {
   const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE, NODE_ENTRY, LOGGER_MODULE, mode, dir], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
   });
   running.add(child);
   const ready = new Deferred<number>();
   const ended = new Deferred<ChildEnd>();
   let stdout = '';
   let stderr = '';
   child.stdout.on('data', chunk => {
      stdout += String(chunk);
      const match = /ready (\d+)/.exec(stdout);
      if (match) {
         ready.resolve(Number(match[1]));
      }
   });
   child.stderr.on('data', chunk => {
      stderr += String(chunk);
   });
   child.once('error', error => {
      ready.reject(error);
      ended.reject(error);
   });
   child.once('exit', (code, signal) => {
      running.delete(child);
      ready.reject(new Error(`child ended before it was ready (code ${code}, signal ${signal}): ${stderr}`));
      ended.resolve({ code, signal });
   });
   // Observed internally, so a case that only awaits `ended` leaves no unhandled rejection.
   void ready.promise.catch(() => undefined);
   return {
      pid: child.pid,
      ready: ready.promise,
      ended: ended.promise,
      stdout: () => stdout,
      stderr: () => stderr,
      exit: () => child.stdin.write('exit\n'),
      kill: signal => child.kill(signal)
   };
}

/** Read `file` as a V8 CPU profile, failing with what the directory holds when it is missing. */
function readProfile(file: string): { nodes: unknown[]; samples: unknown[]; startTime: number; endTime: number } {
   expect(existsSync(file), `no profile at ${file}; the directory holds: ${readdirSync(dir).join(', ') || '(nothing)'}`).toBe(true);
   const profile: unknown = JSON.parse(readFileSync(file, 'utf8'));
   expect(profile).toMatchObject({ nodes: expect.any(Array), samples: expect.any(Array) });
   const typed = profile as { nodes: unknown[]; samples: unknown[]; startTime: number; endTime: number };
   expect(typed.nodes.length).toBeGreaterThan(0);
   return typed;
}

describe('startup CPU profile', () => {
   const template = (): string => path.join(dir, '{workspace}.cpuprofile');

   it(
      'writes the profile on a normal exit, named through the {workspace} placeholder',
      async () => {
         const child = startChild('plain', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.exit();
         const end = await child.ended;

         expect(end, child.stderr()).toEqual({ code: 0, signal: null });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it(
      'names the profile _startup-<pid> when the workspace never became known',
      async () => {
         const child = startChild('unresolved', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.exit();
         await child.ended;

         readProfile(path.join(dir, `_startup-${child.pid}.cpuprofile`));
      },
      CHILD_TIMEOUT_MS
   );

   // SIGTERM on Windows ends a process without running its listeners, so the
   // cases that expect a profile from one are POSIX-only.
   it.skipIf(process.platform === 'win32')(
      'writes the profile on SIGTERM and still ends by the signal',
      async () => {
         const child = startChild('plain', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.kill('SIGTERM');
         const end = await child.ended;

         // A host that reads the signal (a supervisor, a test runner) must see
         // the same ending it would without the profile.
         expect(end, child.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it.skipIf(process.platform === 'win32')(
      'writes the profile when SIGTERM repeats while the write runs, as a host ending its process tree sends it',
      async () => {
         const child = startChild('plain', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         // A tight loop of SIGTERMs until the child is gone, so at least one
         // lands while the profile is being stopped and written.
         const storm = spawn('sh', ['-c', `while kill -TERM ${child.pid} 2>/dev/null; do :; done`], { stdio: 'ignore' });
         running.add(storm);
         const end = await child.ended;

         expect(end, child.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it.skipIf(process.platform === 'win32')(
      'leaves the ending to another SIGTERM listener when there is one, and still writes',
      async () => {
         const child = startChild('other-listener', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.kill('SIGTERM');
         const end = await child.ended;

         // 7 when the listener ran once: a re-raised signal would reach it twice.
         expect(end, child.stderr()).toEqual({ code: 7, signal: null });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it.skipIf(process.platform === 'win32')(
      'leaves the ending to a once listener registered before the entry loaded',
      async () => {
         const child = startChild('adopter-once-first', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.kill('SIGTERM');
         const end = await child.ended;

         // That listener has removed itself by the time a listener behind it
         // counts, so counting there re-raises into its async shutdown.
         expect(end, child.stderr()).toEqual({ code: 9, signal: null });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it(
      'keeps one profile per server when two servers open the same workspace under a capture',
      async () => {
         const previous = { dir: process.env[DEFAULT_SERVER_LOG_DIR_ENV], opt: process.env[DEFAULT_SERVER_CPU_PROFILE_ENV] };
         process.env[DEFAULT_SERVER_CPU_PROFILE_ENV] = '1';
         try {
            const { env } = captureServerLog({ dir });
            const pids: Array<number | undefined> = [];
            for (let i = 0; i < 2; i++) {
               const child = startChild('plain', env);
               await child.ready;
               child.exit();
               await child.ended;
               pids.push(child.pid);
            }

            const profiles = readdirSync(dir)
               .filter(file => file.endsWith('.cpuprofile'))
               .sort();
            expect(profiles).toEqual(pids.map(pid => `ws-token.${pid}.cpuprofile`).sort());
            for (const file of profiles) {
               readProfile(path.join(dir, file));
            }
         } finally {
            restoreEnv(DEFAULT_SERVER_LOG_DIR_ENV, previous.dir);
            restoreEnv(DEFAULT_SERVER_CPU_PROFILE_ENV, previous.opt);
         }
      },
      CHILD_TIMEOUT_MS
   );

   it(
      'runs beside a ProfileCapture window, each session keeping its own profile',
      async () => {
         const child = startChild('window', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.exit();
         await child.ended;

         const windowFile = readdirSync(dir).find(file => file.startsWith('server-cpu') && file.endsWith('.cpuprofile'));
         expect(windowFile, `the window wrote no profile; the directory holds: ${readdirSync(dir).join(', ')}`).toBeDefined();
         const window = readProfile(path.join(dir, windowFile ?? ''));
         const startup = readProfile(path.join(dir, 'ws-token.cpuprofile'));
         // The startup profile spans the window rather than ending where the
         // window's session stopped.
         expect(startup.startTime).toBeLessThanOrEqual(window.startTime);
         expect(startup.endTime).toBeGreaterThan(window.endTime);
      },
      CHILD_TIMEOUT_MS
   );

   it(
      'profiles the main thread only when a worker loads the entry too',
      async () => {
         const child = startChild('worker', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         await child.ready;
         child.exit();
         await child.ended;

         // A session in the worker would add its exit listener there, and its
         // write would replace the main thread's file, since threads share the pid.
         expect(/worker-exit-listeners-added (\d+)/.exec(child.stdout())?.[1], child.stderr()).toBe('0');
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );

   it(
      'adds no SIGTERM listener and writes nothing when the variable is unset',
      async () => {
         const child = startChild('plain', { [DEFAULT_CPU_PROFILE_FILE_ENV]: '' });
         const listeners = await child.ready;
         child.kill('SIGTERM');
         const end = await child.ended;

         expect(listeners).toBe(0);
         expect(end).toEqual({ code: null, signal: 'SIGTERM' });
         expect(readdirSync(dir)).toEqual([]);
      },
      CHILD_TIMEOUT_MS
   );

   it.skipIf(process.platform === 'win32')(
      'profiles once per process when a second copy of the module loads',
      async () => {
         const child = startChild('second-copy', { [DEFAULT_CPU_PROFILE_FILE_ENV]: template() });
         const listeners = await child.ready;
         child.kill('SIGTERM');
         const end = await child.ended;

         // One session and one listener: a second copy's session would write
         // a profile of its own, under whatever name its placeholders give.
         expect(listeners).toBe(1);
         expect(end, child.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
         readProfile(path.join(dir, 'ws-token.cpuprofile'));
      },
      CHILD_TIMEOUT_MS
   );
});
