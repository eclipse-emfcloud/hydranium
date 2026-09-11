/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A `--require` preload that records why a Node process exited non-zero, for the
 * Windows CI failure where one does so having written nothing at all.
 *
 * ## Why a preload rather than a per-tool instrument
 *
 * The victim is not a tool. Captured `.turbo/*.log` files show the same silent
 * non-zero exit from `tsc --noEmit` (no diagnostic printed), from `eslint`
 * (which exits 1 only when it found problems it would have printed), from a
 * vitest fork worker, and from an intermediate `npm run` that never printed
 * npm's own `Lifecycle script … failed` block. What they share is being a Node
 * child on Windows, so the instrument belongs on every Node process rather than
 * on any one of them.
 *
 * ## Why it writes to a file
 *
 * Both channels a dying process would normally use are already known to lose
 * this: a vitest fork's `stdout`/`stderr` are piped into vitest's own console
 * interception, which attributes output to the running test and drops what
 * arrives after one finishes; and turbo merges every task's streams into one
 * pipe. A file bypasses both. It also keeps the recorder off stdout, which
 * matters because subcommand tests assert on a spawned process's stdout being
 * exactly its payload.
 *
 * ## What each outcome means
 *
 * - an `uncaught` field names the exception and the stack, and the case is closed
 * - an `exitCall` stack with no `uncaught` names the library line calling
 *   `process.exit`, and the case is closed
 * - neither, with a non-zero `code`, means the tool set `process.exitCode`
 *   deliberately — for eslint that would mean real findings whose output was lost
 * - NO RECORD AT ALL for a process that npm reported as exiting 1 means it never
 *   reached a JS exit handler, which moves the question to external termination
 *
 * The last of those is why the self-test below has to exist: a recorder that has
 * silently stopped recording produces the same empty directory as the finding.
 *
 * ## Why it also records the kills this process ISSUES
 *
 * The deaths under investigation are terminations: on Windows every one of them
 * reports exit status 1 with no signal, because libuv passes a hardcoded 1 to
 * `TerminateProcess` for every signal it sends. So the open question is not what
 * kind of death it is but WHO calls it, and a `kills-<pid>.ndjson` naming the
 * target, the child's own argv and the calling stack answers that for every Node
 * process in the run at once.
 *
 * An ABSENCE is the other half and is the more likely reading: no kill record
 * for a pid that the audit trail shows terminated means no Node process in the
 * run asked for it, which leaves turbo, the shell and the OS — none of which
 * this can see. That is a real narrowing and it is also why the self-test has to
 * prove the hook still fires, on the same argument as the records above.
 *
 * ## Constraints this must hold
 *
 * It runs in EVERY Node process of a `npm run check`, including ones whose
 * output is asserted on byte-for-byte, so it must never write to stdout or
 * stderr, never throw, and never change an exit code. It is inert unless
 * `HYDRANIUM_EXIT_TRACE_DIR` names a directory, so a developer machine and an
 * adopter's install are untouched.
 *
 * SCAFFOLDING. Its removal trigger is the `//trace-exits` note in the root
 * manifest, alongside the vitest patch's.
 */

'use strict';

/**
 * Where records go, by two routes, because the first one alone was defeated in
 * the field by the very layer the recorder has to reach.
 *
 * `HYDRANIUM_EXIT_TRACE_DIR` is the explicit switch. It does NOT survive on its
 * own: turbo 2 defaults to a STRICT environment mode, which passes `NODE_OPTIONS`
 * through to a task but drops an undeclared variable — so the preload loaded
 * inside every task and then went inert on this guard, and the first red run
 * recorded only the two processes OUTSIDE turbo. `turbo.json` now declares the
 * variable, and that declaration is asserted by the self-test.
 *
 * The FALLBACK is what makes the recorder independent of that declaration
 * holding: an `exit-trace` directory beside this script's own package root,
 * located from `__dirname` rather than from the environment, and used only when
 * it ALREADY EXISTS. The gate step creates it; nothing else does, so a developer
 * tree and an adopter's install stay inert exactly as before. Existence rather
 * than creation is the whole of that property — a recorder that made the
 * directory would arm itself everywhere.
 */
function resolveTraceDir() {
   const fromEnvironment = process.env.HYDRANIUM_EXIT_TRACE_DIR;
   if (fromEnvironment) {
      return fromEnvironment;
   }
   try {
      const { existsSync } = require('node:fs');
      const { join } = require('node:path');
      const beside = join(__dirname, '..', 'exit-trace');
      return existsSync(beside) ? beside : undefined;
   } catch {
      return undefined;
   }
}

const TRACE_DIR = resolveTraceDir();

/**
 * Everything the recorder learns before it is allowed to write, which is at
 * `exit` and no earlier: only there is the FINAL code known, and a process that
 * ends up exiting 0 must leave no file behind — an artefact holding one entry
 * per healthy process would bury the handful that matter.
 */
let uncaught;
let exitCall;

/** Never let the recorder's own failure become the process's failure. */
function safely(action) {
   try {
      action();
   } catch {
      // Deliberately empty. A recorder that throws would convert the silent
      // failure under investigation into a different one, attributed here.
   }
}

/**
 * A stream's state at exit. `pending` is the point of it: bytes still queued on
 * a stream nobody will drain again are output the reader never saw, which is one
 * of the two standing explanations for the silence and is otherwise unobservable
 * from outside the process.
 */
function streamState(stream) {
   if (!stream) {
      return undefined;
   }
   return {
      pending: stream.writableLength,
      ended: stream.writableEnded === true,
      destroyed: stream.destroyed === true,
      errored: stream.errored ? String(stream.errored.message || stream.errored) : undefined
   };
}

function describe(error) {
   if (!(error instanceof Error)) {
      return { message: String(error) };
   }
   return { name: error.name, message: error.message, stack: error.stack };
}

/**
 * Every kill this process asks for, appended as it happens rather than held
 * until exit: the caller is frequently still alive when the evidence is read,
 * and a process that is itself killed would take a buffered list with it.
 *
 * The stack is TRIMMED because the useful part is the call site, and vitest
 * alone issues one kill per test file — a full stack per record turns a routine
 * teardown into megabytes. The child's `spawnargs` are what make a record
 * readable at all: Windows reuses pids hard enough that a target pid on its own
 * is ambiguous, and the argv says which process this actually was.
 */
function recordKill(target, signal, argv) {
   safely(() => {
      const { appendFileSync, mkdirSync } = require('node:fs');
      const { join } = require('node:path');
      const stack = (new Error('kill').stack || '').split('\n').slice(1, 9).join('\n');
      const record = {
         at: new Date().toISOString(),
         by: process.pid,
         target: typeof target === 'number' ? target : null,
         signal: signal === undefined ? null : String(signal),
         argv: Array.isArray(argv) ? argv.join(' ').slice(0, 300) : undefined,
         stack
      };
      mkdirSync(TRACE_DIR, { recursive: true });
      appendFileSync(join(TRACE_DIR, `kills-${process.pid}.ndjson`), `${JSON.stringify(record)}\n`);
   });
}

function install() {
   const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
   const { join } = require('node:path');

   // A START marker, removed by the `exit` handler however the process ends. It
   // splits the previously ambiguous outcome: an absent exit record meant
   // EITHER that the process never reached JS or that it ran and was then
   // killed past every handler, and those need different investigations.
   //
   // The gate legitimately kills spawned servers, so surviving markers are
   // read against the failed task rather than counted.
   const startMarker = join(TRACE_DIR, `start-${process.pid}.json`);
   safely(() => {
      mkdirSync(TRACE_DIR, { recursive: true });
      writeFileSync(startMarker, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv, cwd: process.cwd() })}\n`);
   });

   // `uncaughtExceptionMonitor` and NOT `uncaughtException`: the monitor
   // observes and leaves Node's default crash behaviour in place, whereas a
   // plain listener SUPPRESSES it and would turn a process that dies into one
   // that survives — changing the very outcome being measured.
   process.on('uncaughtExceptionMonitor', (error, origin) => {
      safely(() => {
         uncaught = { origin, ...describe(error) };
      });
   });

   // An unhandled rejection has no monitor variant, and a plain listener would
   // suppress the default throw. Under Node's default `--unhandled-rejections=throw`
   // it becomes an uncaught exception, so the monitor above already sees it.

   // BOTH kill routes, because they are different mechanisms and only one of
   // them is safe against pid reuse. `ChildProcess.kill` goes through the handle
   // libuv still holds, so it can never reach a process that has already been
   // reaped; `process.kill` takes a bare pid and can. A record from the second
   // with a target the caller no longer owns is therefore a finding in itself.
   //
   // Wrapped rather than observed: Node emits no event for either. Signal `0`
   // kills nothing and is a liveness probe, so a reader counting records has to
   // read the signal field rather than the line.
   const { ChildProcess } = require('node:child_process');
   const realChildKill = ChildProcess.prototype.kill;
   ChildProcess.prototype.kill = function kill(signal) {
      recordKill(this.pid, signal, this.spawnargs);
      return realChildKill.apply(this, arguments);
   };

   const realProcessKill = process.kill;
   process.kill = function kill(pid, signal) {
      recordKill(pid, signal, undefined);
      return realProcessKill.apply(process, arguments);
   };

   const realExit = process.exit;
   process.exit = function exit(...args) {
      safely(() => {
         // Captured rather than written: an explicit `process.exit(0)` is
         // ordinary — tsc calls one on a clean run — and only the final code
         // decides whether this mattered.
         exitCall = new Error('process.exit').stack;
      });
      return realExit.apply(process, args);
   };

   process.on('exit', code => {
      // Cleared for EVERY exit, zero or not: the marker means "ran no exit
      // handler", so one left behind by a normal exit destroys the signal.
      safely(() => rmSync(startMarker, { force: true }));
      if (code === 0) {
         return;
      }
      safely(() => {
         mkdirSync(TRACE_DIR, { recursive: true });
         const record = {
            pid: process.pid,
            ppid: process.ppid,
            code,
            uptimeMs: Math.round(process.uptime() * 1000),
            argv: process.argv,
            cwd: process.cwd(),
            uncaught,
            exitCall,
            stdout: streamState(process.stdout),
            stderr: streamState(process.stderr)
         };
         // One file per process rather than one shared file: the whole point is
         // a run with dozens of concurrent Node processes, and concurrent
         // appends to one file on Windows have no atomicity guarantee worth
         // relying on when the thing being measured is already a Windows
         // anomaly. The pid is in the name AND in the record, because a pid is
         // reused within a job long enough for two entries to share a file.
         appendFileSync(join(TRACE_DIR, `exit-${process.pid}.json`), `${JSON.stringify(record)}\n`);
      });
   });
}

if (TRACE_DIR) {
   safely(install);
}
