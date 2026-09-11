/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `startSpawnedServer` driven against a MINIMAL FAKE peer rather than a real
 * head.
 *
 * A real head would supply every observable here by itself — it answers
 * `initialize`, it publishes, it logs, it exits on `exit` — so the suite would
 * pass under a harness that registered its captures too late, asked for a port
 * once instead of polling, or never killed anything. It also cannot be made to
 * die mid-handshake, hang on `shutdown`, or leak a log onto the protocol
 * channel, which is most of what this harness exists to report. The fake in
 * `fixtures/fake-stdio-lsp-server.mjs` has a mode for each.
 *
 * The fake's own markers are mirrored below rather than imported: it is a Node
 * script spawned by path, not a module this suite may load — loading it would
 * run a JSON-RPC peer inside the test worker. A drift between the two copies
 * turns a positive assertion red, so it cannot produce a false green.
 *
 * Every process this suite starts is accounted for. An orphan holding a pipe or
 * a port makes the NEXT run's verdict meaningless, so the fake records its own
 * pid and the teardown kills exactly those pids — never a pattern, which could
 * match inside the test runner's own tree.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
   SPAWNED_SERVER_BOOT_TIMEOUT_MS,
   startSpawnedServer,
   type SpawnedServer,
   type SpawnedServerOptions
} from '../../src/testing/node/spawned-server.js';

const FIXTURE_MODULE = fileURLToPath(new URL('./fixtures/fake-stdio-lsp-server.mjs', import.meta.url));

/** Mirrors of the fake's markers — see the note above on why they are copied. */
const FIXTURE_SERVER_NAME = 'fake-stdio-lsp-server';
const FIXTURE_PORT = 54321;
const FIXTURE_PORT_ATTEMPTS = 3;
const FIXTURE_LOG_MESSAGE = 'fake-stdio-lsp-server: booted';
const FIXTURE_STDERR_MARKER = 'fake-stdio-lsp-server: on stderr';
const FIXTURE_STDOUT_NOISE = 'fake-stdio-lsp-server: leaked onto stdout';
const FIXTURE_DIAGNOSTIC_URI = 'file:///a.x';
const FIXTURE_FIRST_DIAGNOSTIC = 'first';

/** The port command the fake answers, once polled enough times. */
const PORT_COMMAND = 'ns/head/port';

/**
 * Bounds the cases that assert the TIMEOUT message, so the suite does not wait
 * out the production default for each of them.
 *
 * It cannot be shortened much, and the reason is easy to miss: every one of
 * these cases asserts something the CHILD produced — its pid file, its stdout,
 * its stderr — so the child has to finish spawning and loading its module
 * before the timer fires. Under the budget it fails on an empty capture rather
 * than on the behaviour under test. Windows CI has been measured spending 2-3s
 * on that startup, where a 1s budget failed deterministically rather than
 * intermittently, and lost a further assertion each time startup got slower.
 *
 * The case where the timer must LOSE passes its own bound instead; see the
 * mid-handshake exit test.
 */
const SHORT_BOOT_MS = 8_000;

/**
 * vitest's own per-test bound for the cases that wait out {@link SHORT_BOOT_MS}.
 *
 * Derived rather than written out, because the two bounds race and vitest wins
 * ties: left at its 5s default, a boot budget at or above it reports
 * "Test timed out" and the assertion under test never runs, which reads as a
 * broken test rather than a slow one.
 */
const TIMER_BOUND_TEST_MS = SHORT_BOOT_MS * 3;

/** Grace before `SIGKILL` in the teardown tests, applied twice by the harness. */
const SHORT_KILL_MS = 250;

/**
 * How long the decoy case waits before calling a process unharmed. Orders of
 * magnitude above the kill it is ruling out, which its paired case shows
 * landing immediately, and paid only twice.
 */
const DECOY_SETTLE_MS = 300;

/**
 * One spawned fake, and whether its exit has been OBSERVED.
 *
 * That flag is the whole safety of the teardown below. A pid identifies a
 * process only while that process is alive: once it exits the OS is free to
 * reissue the number, and Windows does so within SECONDS. So a recorded pid
 * whose child has already been reaped names nothing, and signalling one reaches
 * whatever holds it now — under a concurrent build, another task's compiler,
 * test runner or npm, killed with no handler run and no output.
 *
 * This is not hypothetical and it is not cheap. It reddened the Windows leg for
 * weeks: this suite's own teardown was killing unrelated processes across the
 * build, and the victims looked like a Node bug because a Windows `SIGKILL` is
 * `TerminateProcess(handle, 1)` — exit 1, no signal, nothing on any stream.
 */
interface Spawn {
   readonly label: string;
   readonly pidFile: string;
   /** Set once the harness has AWAITED the child's exit, after which the pid is meaningless. */
   reaped: boolean;
}

let tempRoot: string;
const openServers: { server: SpawnedServer; spawn: Spawn }[] = [];
const spawns: Spawn[] = [];

/**
 * `true` while `pid` names a live process; the reaped child throws `ESRCH`.
 *
 * Answers "is SOMETHING there", never "is it OURS" — so a caller must already
 * have a reason to believe the pid is still its own. See {@link Spawn.reaped}.
 */
function isAlive(pid: number): boolean {
   try {
      process.kill(pid, 0);
      return true;
   } catch {
      return false;
   }
}

/**
 * Kill any fake whose exit was never observed, and NOTHING else.
 *
 * An orphan holding a pipe or a port makes the next run's verdict meaningless,
 * which is why the net exists; a pid we have already reaped is someone else's
 * process, which is why `reaped` is checked before the pid is read at all.
 * Exact pids only — a `pkill` on the module path would also match this worker's
 * own argv, and an orphan reparented to init still carries it.
 *
 * Extracted from the teardown hook so it can be tested: an `afterAll` body
 * cannot be driven with a pid that is deliberately not ours.
 */
function killUnreapedFakes(entries: readonly Spawn[]): void {
   for (const entry of entries) {
      if (entry.reaped) {
         continue;
      }
      try {
         const pid = Number(readFileSync(entry.pidFile, 'utf8'));
         if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
            process.kill(pid, 'SIGKILL');
         }
      } catch {
         // The mode never got far enough to record a pid.
      }
   }
}

/** The pid the fake recorded, so a dead child is still identifiable. */
function recordedPid(label: string): number {
   return Number(readFileSync(path.join(tempRoot, `${label}.pid`), 'utf8'));
}

/** Register a spawn of `label` for teardown, and return its record. */
function register(label: string): Spawn {
   const spawn: Spawn = { label, pidFile: path.join(tempRoot, `${label}.pid`), reaped: false };
   spawns.push(spawn);
   return spawn;
}

/** Spawn the fake in `mode`, registering it for teardown. */
async function boot(label: string, mode: string, options: Partial<SpawnedServerOptions> = {}): Promise<SpawnedServer> {
   const spawn = register(label);
   const server = await startSpawnedServer({
      serverModule: FIXTURE_MODULE,
      env: { FAKE_LSP_MODE: mode, FAKE_LSP_PID_FILE: spawn.pidFile },
      ...options
   });
   openServers.push({ server, spawn });
   return server;
}

/** Spawn the fake in a mode whose boot must FAIL, and return the rejection. */
async function bootFailure(label: string, mode: string, options: Partial<SpawnedServerOptions> = {}): Promise<Error> {
   const spawn = register(label);
   let server: SpawnedServer;
   try {
      server = await startSpawnedServer({
         serverModule: FIXTURE_MODULE,
         bootTimeoutMs: SHORT_BOOT_MS,
         env: { FAKE_LSP_MODE: mode, FAKE_LSP_PID_FILE: spawn.pidFile },
         ...options
      });
   } catch (error: unknown) {
      if (!(error instanceof Error)) {
         throw error;
      }
      // `startSpawnedServer` force-terminates and AWAITS the exit before it
      // rejects, so a boot failure leaves no live child and no usable pid.
      spawn.reaped = true;
      return error;
   }
   // Registered before throwing, so the teardown still reaps a child this
   // case did not expect to exist.
   openServers.push({ server, spawn });
   throw new Error(`boot unexpectedly succeeded in mode "${mode}"`);
}

describe('startSpawnedServer', () => {
   beforeAll(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'hydranium-spawned-server-'));
   });

   afterEach(async () => {
      while (openServers.length > 0) {
         const entry = openServers.pop();
         if (!entry) {
            continue;
         }
         await entry.server.dispose();
         // `dispose` awaits the child's close, so from here its pid belongs to
         // the OS again and must never be signalled.
         entry.spawn.reaped = true;
      }
   });

   afterAll(() => {
      killUnreapedFakes(spawns);
      rmSync(tempRoot, { recursive: true, force: true });
   });

   it('captures the publish and the log message that arrive BEFORE the initialize response', async () => {
      const server = await boot('captures', 'default');

      expect(server.initializeResult.serverInfo?.name).toBe(FIXTURE_SERVER_NAME);
      // The fake writes both notifications ahead of the handshake response, so
      // these are only present if the captures were registered before `listen()`.
      expect(server.diagnostics.map(params => params.uri)).toEqual([FIXTURE_DIAGNOSTIC_URI]);
      expect(server.diagnostics[0].diagnostics[0].message).toBe(FIXTURE_FIRST_DIAGNOSTIC);
      expect(server.logMessages.map(message => message.message)).toContain(FIXTURE_LOG_MESSAGE);
      // Captured and reported, never asserted empty: the line count of a real
      // head's stderr is log-level-dependent.
      expect(server.stderr()).toContain(FIXTURE_STDERR_MARKER);
   });

   it('hands the workspace folder to the child through the handshake', async () => {
      const server = await boot('folder', 'default', { workspaceRoot: tempRoot, workspaceFolderName: 'ns-workspace' });

      const received = await server.connection.sendRequest<{
         rootUri: string | null;
         workspaceFolders: ReadonlyArray<{ uri: string; name: string }> | null;
      }>('probe/initializeParams');

      expect(received.rootUri).toBe(pathToFileURL(tempRoot).toString());
      expect(received.workspaceFolders).toEqual([{ uri: pathToFileURL(tempRoot).toString(), name: 'ns-workspace' }]);
   });

   it('reads the diagnostics tail from fromIndex, not the first publish for the URI', async () => {
      const server = await boot('tail', 'default');

      const from = server.diagnostics.length;
      // The fake writes the notification before answering, so awaiting the
      // response means the publish has ALREADY been dispatched — which is the
      // race `fromIndex` exists for, exercised rather than assumed.
      await server.connection.sendRequest('probe/publish', { uri: FIXTURE_DIAGNOSTIC_URI, message: 'second' });

      const tail = await server.nextDiagnostics(FIXTURE_DIAGNOSTIC_URI, { fromIndex: from });
      expect(tail[0].message).toBe('second');
      // From zero the same call must answer with the earlier one, so the index
      // is doing the selecting rather than "the latest" happening to be right.
      const head = await server.nextDiagnostics(FIXTURE_DIAGNOSTIC_URI, { fromIndex: 0 });
      expect(head[0].message).toBe(FIXTURE_FIRST_DIAGNOSTIC);
   });

   it('ignores already-captured publishes when no fromIndex is given', async () => {
      const server = await boot('no-index', 'default');

      await expect(server.nextDiagnostics(FIXTURE_DIAGNOSTIC_URI, { timeoutMs: 300 })).rejects.toThrow(
         /Timed out waiting for diagnostics for file:\/\/\/a\.x/
      );
   });

   it('polls for a head port, and the boot asks for none', async () => {
      const server = await boot('port', 'default');

      // The asymmetry the tier depends on: a broken port publication must fail
      // only the caller that asks. Folding the poll into the boot would redden
      // every suite for one head's break.
      expect(await server.connection.sendRequest<number>('probe/attempts', { method: PORT_COMMAND })).toBe(0);

      expect(await server.port(PORT_COMMAND, { intervalMs: 5 })).toBe(FIXTURE_PORT);
      // The fake swallows the first requests, so a single-shot lookup cannot
      // have produced the answer above.
      expect(await server.connection.sendRequest<number>('probe/attempts', { method: PORT_COMMAND })).toBeGreaterThanOrEqual(
         FIXTURE_PORT_ATTEMPTS
      );
   });

   it('rejects naming the command when a port is never published', async () => {
      const server = await boot('port-absent', 'default');

      await expect(server.port('ns/absent/port', { attempts: 3, intervalMs: 5 })).rejects.toThrow(
         'No port published for LSP request "ns/absent/port" after 3 attempts'
      );
   });

   it('terminates the child through the graceful pair, idempotently', async () => {
      const server = await boot('graceful', 'default');
      const pid = recordedPid('graceful');
      expect(isAlive(pid)).toBe(true);

      // Zero only if `exit` actually arrived: the fake holds a ref'd interval,
      // so nothing else would end it inside this test's horizon.
      expect(await server.dispose()).toBe(0);
      expect(isAlive(pid)).toBe(false);
      expect(await server.dispose()).toBe(0);
   });

   it('falls back to SIGKILL for a child that never answers shutdown', async () => {
      const server = await boot('hangs', 'ignore-shutdown', { killTimeoutMs: SHORT_KILL_MS });
      const pid = recordedPid('hangs');

      // A null code IS the observable that the graceful path did not work: the
      // fake answers neither `shutdown` nor `exit`, so both bounds have to
      // expire and the signal has to land.
      expect(await server.dispose()).toBeNull();
      expect(isAlive(pid)).toBe(false);
   });

   it(
      'rejects naming the module when the handshake never answers, and leaves no child',
      async () => {
         const error = await bootFailure('silent', 'no-initialize');

         expect(error.message).toContain(FIXTURE_MODULE);
         expect(error.message).toContain(`did not answer "initialize" within ${SHORT_BOOT_MS}ms`);
         // Reads the pid the CHILD recorded, so the boot budget above has to be
         // long enough for it to have got there: the harness force-terminates
         // before this line runs, so a child killed mid-startup never writes the
         // file and this fails on ENOENT rather than on a surviving process.
         expect(isAlive(recordedPid('silent'))).toBe(false);
      },
      TIMER_BOUND_TEST_MS
   );

   it(
      'reports a log leaked onto stdout as the first bytes on the protocol channel',
      async () => {
         const error = await bootFailure('noisy', 'stdout-noise');

         // stdout is the transport, so this is how a framework log routed to it
         // surfaces — as the bytes ahead of any framing, quoted in the failure.
         expect(error.message).toContain(FIXTURE_STDOUT_NOISE);
         expect(error.message).toContain(FIXTURE_STDERR_MARKER);
      },
      TIMER_BOUND_TEST_MS
   );

   it('fails as an exit rather than as a timeout when the child dies mid-handshake', async () => {
      // The production bound rather than SHORT_BOOT_MS, because here the timer
      // is the LOSER of the race under test: a short budget lets the timeout
      // win on a slow runner, which is the one outcome this test exists to
      // rule out. It costs nothing — the child exits promptly, so the bound is
      // never reached on the path that passes.
      const error = await bootFailure('dies', 'die-on-initialize', { bootTimeoutMs: SPAWNED_SERVER_BOOT_TIMEOUT_MS });

      expect(error.message).toContain('exited with code 3 during the handshake');
   });

   it('fails naming the path when the built module is not there', async () => {
      const absent = path.join(tempRoot, 'not-built.js');

      await expect(startSpawnedServer({ serverModule: absent })).rejects.toThrow(`Spawned-server module missing at ${absent}`);
   });

   /**
    * The teardown's own discipline, driven against a DECOY rather than a fake.
    *
    * Pid reuse cannot be provoked on demand, but it does not need to be: what
    * reuse produces is a recorded pid held by a process that is not ours, and a
    * decoy supplies exactly that with no waiting and on every platform. The two
    * cases are a pair and neither means anything alone — the first alone is
    * satisfied by a teardown that kills nothing at all, and the second alone by
    * one that kills everything it is handed.
    */
   describe('killing leftover fakes', () => {
      let decoy: ChildProcess;
      let decoyPidFile: string;

      beforeEach(async () => {
         decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
         await once(decoy, 'spawn');
         decoyPidFile = path.join(tempRoot, 'decoy.pid');
         writeFileSync(decoyPidFile, String(decoy.pid));
      });

      afterEach(() => {
         decoy.kill('SIGKILL');
      });

      it('spares a process holding the pid of a fake whose exit was already observed', async () => {
         killUnreapedFakes([{ label: 'decoy', pidFile: decoyPidFile, reaped: true }]);

         // An absence needs a wait longer than the act would have taken, and
         // the case below measures that: a kill it does issue lands in under a
         // millisecond.
         await delay(DECOY_SETTLE_MS);
         expect(decoy.exitCode).toBeNull();
         expect(decoy.signalCode).toBeNull();
      });

      it('kills a fake whose exit was never observed', async () => {
         killUnreapedFakes([{ label: 'decoy', pidFile: decoyPidFile, reaped: false }]);

         await once(decoy, 'exit');
         expect(decoy.exitCode === null && decoy.signalCode === null).toBe(false);
      });
   });
});
