/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DEFAULT_CPU_PROFILE_FILE_ENV } from '@hydranium/protocol';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { dirname } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { expandLogFilePlaceholders } from '../langium/diagnostics/logger.js';

/**
 * Marks the profile started on `globalThis` rather than in this module, since
 * a second installed copy of the package loads its own module and would start
 * a second session writing a profile of its own.
 */
const CPU_PROFILE_STARTED: unique symbol = Symbol.for('@hydranium/core#startupCpuProfileStarted');
const processGlobal = globalThis as typeof globalThis & { [CPU_PROFILE_STARTED]?: true };

/**
 * Start profiling this process when {@link DEFAULT_CPU_PROFILE_FILE_ENV} is
 * set, and write the profile once, on `exit` or on SIGTERM. Called when
 * `@hydranium/core/node` loads, so every Node head is profiled from before its
 * workspace load; a no-op on a second call, from any copy of the package, and
 * in a `worker_threads` worker.
 *
 * `--cpu-prof` is no substitute: it writes only on a normal exit, and SIGTERM
 * ends a process without one. The SIGTERM listener re-raises the signal when it
 * is the only one, so the process still ends by it; another listener keeps
 * control of the ending. Samples accumulate for the life of the process, so
 * this is for test runs, not a production server.
 *
 * A head in a worker is not profiled: a worker's session would write the main
 * thread's file, since threads share the pid, no signal reaches it, and its
 * `exit` listeners run neither when it is terminated nor when the process ends.
 *
 * A `ProfileCapture` window runs beside it in its own inspector session.
 */
export function startCpuProfileFromEnv(): void {
   const template = process.env[DEFAULT_CPU_PROFILE_FILE_ENV];
   if (!template || !isMainThread || processGlobal[CPU_PROFILE_STARTED]) {
      return;
   }
   processGlobal[CPU_PROFILE_STARTED] = true;
   const session = new Session();
   session.connect();
   session.post('Profiler.enable');
   session.post('Profiler.start');
   let written = false;
   // Synchronous throughout: an in-process session answers `post` before it
   // returns, and nothing asynchronous runs after `exit`. The session is
   // disconnected from the answer, so nothing here depends on that order.
   const write = (): void => {
      if (written) {
         return;
      }
      written = true;
      const file = expandLogFilePlaceholders(template);
      session.post('Profiler.stop', (error, result) => {
         try {
            if (error) {
               throw error;
            }
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(result.profile));
         } catch (err: unknown) {
            process.stderr.write(
               `[hydranium] Could not write the CPU profile to ${file}: ${err instanceof Error ? err.message : String(err)}\n`
            );
         }
         session.disconnect();
      });
   };
   process.once('exit', write);
   // Registered until the write is done, not `once`: a `once` listener is gone
   // before it runs, and with no listener left the default action ends the
   // process on a second SIGTERM, which a host ending its process tree sends
   // while the write is still running. Prepended: a `once` listener ahead of
   // this one has removed itself by the time this counts, which would re-raise
   // into its unfinished shutdown.
   const writeOnSigterm = (): void => {
      write();
      process.removeListener('SIGTERM', writeOnSigterm);
      if (process.listenerCount('SIGTERM') === 0) {
         process.kill(process.pid, 'SIGTERM');
      }
   };
   process.prependListener('SIGTERM', writeOnSigterm);
}
