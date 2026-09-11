/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The subprocess tier: a BUILT server entry run as a real child process and
 * driven over the real LSP wire.
 *
 * Four claims are reachable from nowhere else. That the built entry is
 * executable and composes at all — every in-process tier constructs the
 * services tree itself and so cannot fail on a missing registration in the
 * entry module. That **stdout carries nothing but protocol** under `--stdio`,
 * because stdout IS the transport there: a framework or third-party log written
 * to it corrupts the JSON-RPC framing, and the handshake is what detects it.
 * That an ephemeral port is published where a host can find it. And that
 * shutdown actually terminates the process.
 *
 * Two properties of the transport shape this code.
 *
 * - **stderr is captured for REPORTING, never asserted empty.** With a client
 *   attached, log output routes over `window/logMessage`, so the stderr line
 *   count is log-level-dependent and unbounded — an assertion over it is
 *   vacuous in one configuration and flaky in another. A suite asking "did the
 *   logs corrupt the protocol?" reads {@link SpawnedServer.logMessages}.
 * - **A publish fans out.** Diagnostics are captured append-only and read by
 *   index, the discipline `LspServerConnection.diagnostics` names: record the
 *   length before acting, then read the tail. A register-one-handler-per-wait
 *   scheme loses races instead, because `onNotification` keeps exactly ONE
 *   handler per method and a second registration silently displaces the first.
 *
 * **The port lookup is deliberately NOT part of the boot.**
 * {@link SpawnedServer.port} is a method a caller invokes, so a head whose port
 * publication is broken fails only the suite that asks for that port. Polling
 * every head's port during the handshake would make one head's break red across
 * every suite and destroy the per-transport asymmetry this tier exists to
 * measure.
 */

import { type Harness } from '@hydranium/protocol/testing';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
   ExitNotification,
   InitializeRequest,
   InitializedNotification,
   LogMessageNotification,
   ShutdownRequest,
   PublishDiagnosticsNotification,
   createProtocolConnection,
   type Diagnostic,
   type InitializeParams,
   type InitializeResult,
   type LogMessageParams,
   type ProtocolConnection,
   type PublishDiagnosticsParams
} from 'vscode-languageserver-protocol/node';
import { type NextDiagnosticsOptions } from './lsp-server-connection.js';

/**
 * Default bound on the `initialize` handshake, and the reason there is one at
 * all: without it a child that never answers hangs until the test runner's own
 * timeout, which reports as an anonymous hang and names neither the module nor
 * what was on its streams.
 *
 * Sized for a COLD subprocess boot — several grammars plus whatever else the
 * entry composes, on a machine already running the rest of the suite in
 * parallel — so it is far past a runner's default and is not a latency
 * measurement.
 */
export const SPAWNED_SERVER_BOOT_TIMEOUT_MS = 45_000;

/**
 * What to give a test hook that boots or tears down a spawned server.
 *
 * Deliberately LARGER than {@link SPAWNED_SERVER_BOOT_TIMEOUT_MS}: the two
 * budgets race, and the harness's own error is the one that names the module,
 * the stdout prefix and the captured stderr. A hook budget at or below the boot
 * budget wins that race and throws all of it away.
 */
export const SPAWNED_SERVER_HOOK_TIMEOUT_MS = 60_000;

/** Wait for a single post-boot publish or port answer, once the process is warm. */
const RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Grace between the graceful teardown and `SIGKILL`, applied TWICE — once to the
 * `shutdown` request and once to the process exit. A child that hangs answering
 * `shutdown` is a distinct fault from one that answers and then fails to exit,
 * and a fallback covering only the second leaves teardown able to hang forever.
 */
const DEFAULT_KILL_TIMEOUT_MS = 3_000;

/** Default child arguments: the stdio transport, where stdout is the protocol channel. */
const DEFAULT_ARGS: readonly string[] = ['--stdio'];

/**
 * How much of the child's stdout to keep for a boot-failure report. Bounded
 * because the healthy content is protocol framing and unbounded protocol in an
 * error message buries the one interesting case, which is a log line arriving
 * BEFORE any framing.
 */
const STDOUT_PREFIX_LIMIT = 400;

/** Options for {@link SpawnedServer.port}. */
export interface PortLookupOptions {
   /** Give up after this many requests. */
   readonly attempts?: number;
   /** Wait this long between requests. */
   readonly intervalMs?: number;
}

/** Configuration for {@link startSpawnedServer}. */
export interface SpawnedServerOptions {
   /**
    * Absolute path to the BUILT entry module to run — the artefact a host
    * spawns, not its source. A test runner that builds before testing is what
    * guarantees it exists; a missing file fails naming the path, because the
    * alternative failure is an unexplained handshake timeout.
    */
   readonly serverModule: string;
   /** Arguments after the module path. Defaults to the stdio transport flag. */
   readonly args?: readonly string[];
   /**
    * Absolute directory the child indexes as its single workspace folder.
    * Omitted ⇒ no folders, so nothing is discovered or built.
    *
    * Pass a DISPOSABLE COPY of any committed fixture tree: an initial build runs
    * the integrity rules, whose default silent mode persists repairs through the
    * filesystem provider, so a child booted over the committed tree rewrites it.
    */
   readonly workspaceRoot?: string;
   /** Name reported for the workspace folder. Defaults to the folder's basename. */
   readonly workspaceFolderName?: string;
   /**
    * Merged OVER the inherited environment, so a caller can raise the child's
    * log level without touching the test worker's own environment.
    */
   readonly env?: NodeJS.ProcessEnv;
   /** Interpreter to run. Defaults to the current Node executable. */
   readonly execPath?: string;
   /** Fields merged over the default `initialize` params, after the workspace folder. */
   readonly initializeParams?: Partial<InitializeParams>;
   /** Bound on the handshake. Defaults to {@link SPAWNED_SERVER_BOOT_TIMEOUT_MS}. */
   readonly bootTimeoutMs?: number;
   /** Grace before `SIGKILL` during {@link SpawnedServer.dispose}. */
   readonly killTimeoutMs?: number;
}

/** A spawned server entry, initialized and ready to drive. */
export interface SpawnedServer extends Harness {
   /** The client half of the LSP wire to the child. */
   readonly connection: ProtocolConnection;
   /** The child's process id, for asserting that teardown actually terminated it. */
   readonly pid: number | undefined;
   /** What `initialize` answered — the capability surface every head boots behind. */
   readonly initializeResult: InitializeResult;
   /** Every `publishDiagnostics` notification, in arrival order; append-only, never cleared. */
   readonly diagnostics: ReadonlyArray<PublishDiagnosticsParams>;
   /**
    * Every `window/logMessage` notification, in arrival order; append-only.
    *
    * This is where a server's log lines actually go while a client is attached,
    * precisely because stdout is the transport. So the assertion "the logs did
    * not corrupt the protocol" reads THIS, and an stderr-based one is vacuous.
    */
   readonly logMessages: ReadonlyArray<LogMessageParams>;
   /** Everything the child has written to stderr so far. */
   stderr(): string;
   /**
    * Ask the LSP wire for a head's published socket port.
    *
    * Polls rather than waits a fixed time: a port is published once that head's
    * own startup resolves, so the first request can legitimately land before the
    * handler is registered. Rejects naming the command, so an unpublished port
    * fails as itself instead of as a later socket-connect timeout.
    */
   port(command: string, options?: PortLookupOptions): Promise<number>;
   /**
    * Resolve with the diagnostics of the next `publishDiagnostics` matching
    * `uri`. Reject on timeout so a missing publish fails fast instead of
    * hanging.
    *
    * **Pass `{ fromIndex }` for anything a write provoked.** Record
    * {@link diagnostics}`.length` BEFORE the triggering edit and hand it over:
    * that is what makes the read immune both to a publish that arrives before
    * the wait is armed and to an earlier publish for the same URI. Without it
    * this answers "the next publish for one URI", which is the wrong question
    * whenever one action fans out.
    */
   nextDiagnostics(uri: string, timeoutMsOrOptions?: number | NextDiagnosticsOptions): Promise<Diagnostic[]>;
   /**
    * Graceful `shutdown` / `exit`, each bounded, then `SIGKILL`. Resolves with
    * the child's exit code — `null` when a signal ended it, which is itself the
    * observable that the graceful path did not work. Idempotent.
    */
   dispose(): Promise<number | null>;
}

/**
 * Every server started and not yet disposed, so {@link disposeSpawnedServers}
 * can reach one a test forgot.
 *
 * Holds the server — and through it the `ChildProcess` — rather than a pid. A
 * pid identifies a process only while that process is alive: once it exits the
 * OS may reissue the number, and Windows does so within seconds. A teardown
 * that signalled a recorded pid would therefore reach whatever holds it now,
 * which on a concurrent build is another task's compiler or test runner.
 */
const liveServers = new Set<SpawnedServer>();

/**
 * Terminate every server this module started that has not been disposed, and
 * forget them.
 *
 * Safe to call when none are outstanding, and safe to call twice. Nothing here
 * can reach a process this module did not spawn, because every kill goes
 * through the `ChildProcess` handle libuv holds and libuv will not signal a
 * child it has already reaped.
 *
 * A suite that disposes each server as it finishes needs this only as a net; a
 * suite that does not needs it, because an orphan holding a port or a pipe
 * makes the NEXT run's verdict meaningless.
 */
export async function disposeSpawnedServers(): Promise<void> {
   const outstanding = [...liveServers];
   liveServers.clear();
   await Promise.all(outstanding.map(server => server.dispose()));
}

/** The captured streams, quoted into a boot-failure message. */
function bootDiagnosis(stdoutPrefix: string, stderr: string): string {
   return (
      `First bytes on stdout (the protocol channel under the stdio transport, so a log written ` +
      `there corrupts the framing): ${JSON.stringify(stdoutPrefix) || '(nothing)'}. ` +
      `Captured stderr: ${stderr || '(nothing)'}`
   );
}

/**
 * Spawn a built server entry and complete the `initialize` / `initialized`
 * handshake.
 *
 * Rejects rather than hangs on all three ways a boot can fail — the module is
 * not there, the child dies, the handshake never answers — and each rejection
 * carries what the streams held, because the streams are the only evidence a
 * dead child leaves. A failed boot leaves NO child behind: the process is
 * killed before the rejection propagates, since an orphan holding a socket
 * makes the next run's result meaningless.
 */
export async function startSpawnedServer(options: SpawnedServerOptions): Promise<SpawnedServer> {
   const serverModule = path.resolve(options.serverModule);
   if (!existsSync(serverModule)) {
      throw new Error(
         `Spawned-server module missing at ${serverModule}. This tier drives the BUILT artefact, so build the package that produces it before running the test.`
      );
   }

   const child: ChildProcessWithoutNullStreams = spawn(
      options.execPath ?? process.execPath,
      [serverModule, ...(options.args ?? DEFAULT_ARGS)],
      {
         stdio: ['pipe', 'pipe', 'pipe'],
         env: { ...process.env, ...options.env }
      }
   );
   let stderrBuf = '';
   child.stderr.on('data', chunk => {
      stderrBuf += String(chunk);
   });
   // A second `data` listener beside the protocol reader's, so the bytes are
   // both parsed and observable. Without it a log leaked to stdout is visible
   // only as a framing error with nothing to name.
   let stdoutPrefix = '';
   child.stdout.on('data', chunk => {
      if (stdoutPrefix.length < STDOUT_PREFIX_LIMIT) {
         stdoutPrefix = (stdoutPrefix + String(chunk)).slice(0, STDOUT_PREFIX_LIMIT);
      }
   });

   const connection = createProtocolConnection(child.stdout, child.stdin);
   const diagnostics: PublishDiagnosticsParams[] = [];
   /**
    * Waiters armed by {@link SpawnedServer.nextDiagnostics}, fanned out to from
    * the ONE handler below and registered before `listen()`, so no publish that
    * races the handshake can be missed. A second `onNotification` for the same
    * method would displace this one, taking the always-on capture with it.
    */
   const waiters = new Set<(params: PublishDiagnosticsParams) => void>();
   connection.onNotification(PublishDiagnosticsNotification.type, params => {
      diagnostics.push(params);
      for (const notify of [...waiters]) {
         notify(params);
      }
   });
   const logMessages: LogMessageParams[] = [];
   connection.onNotification(LogMessageNotification.type, params => {
      logMessages.push(params);
   });
   connection.listen();

   const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

   /** Terminate unconditionally and wait for the child to be reaped. */
   async function forceTerminate(): Promise<number | null> {
      connection.dispose();
      const exitCode = await new Promise<number | null>(resolve => {
         if (child.exitCode !== null || child.signalCode !== null) {
            resolve(child.exitCode);
            return;
         }
         child.once('close', code => resolve(code));
         child.kill('SIGKILL');
      });
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      return exitCode;
   }

   const rootUri = options.workspaceRoot ? pathToFileURL(options.workspaceRoot).toString() : null;
   const initializeParams: InitializeParams = {
      processId: process.pid,
      rootUri,
      workspaceFolders:
         rootUri && options.workspaceRoot
            ? [{ uri: rootUri, name: options.workspaceFolderName ?? path.basename(options.workspaceRoot) }]
            : null,
      capabilities: {},
      ...options.initializeParams
   };

   const bootTimeoutMs = options.bootTimeoutMs ?? SPAWNED_SERVER_BOOT_TIMEOUT_MS;
   let bootTimer: NodeJS.Timeout | undefined;
   let onEarlyClose: ((code: number | null) => void) | undefined;
   let initializeResult: InitializeResult;
   try {
      initializeResult = await new Promise<InitializeResult>((resolve, reject) => {
         bootTimer = setTimeout(() => {
            reject(
               new Error(
                  `Spawned server ${serverModule} did not answer "initialize" within ${bootTimeoutMs}ms. ${bootDiagnosis(stdoutPrefix, stderrBuf)}`
               )
            );
         }, bootTimeoutMs);
         onEarlyClose = code => {
            reject(
               new Error(
                  `Spawned server ${serverModule} exited with code ${code} during the handshake. ${bootDiagnosis(stdoutPrefix, stderrBuf)}`
               )
            );
         };
         child.once('close', onEarlyClose);
         child.once('error', reject);
         connection.sendRequest(InitializeRequest.type, initializeParams).then(resolve, reject);
      });
   } catch (error: unknown) {
      await forceTerminate();
      throw error;
   } finally {
      clearTimeout(bootTimer);
      if (onEarlyClose) {
         child.off('close', onEarlyClose);
      }
   }
   connection.sendNotification(InitializedNotification.type, {});

   let disposal: Promise<number | null> | undefined;

   /** Bound `promise` by `killTimeoutMs`, resolving either way — teardown never fails on a hang. */
   function bounded(promise: Promise<unknown>): Promise<void> {
      return new Promise<void>(resolve => {
         const timer = setTimeout(resolve, killTimeoutMs);
         promise.then(
            () => {
               clearTimeout(timer);
               resolve();
            },
            () => {
               clearTimeout(timer);
               resolve();
            }
         );
      });
   }

   async function terminate(): Promise<number | null> {
      // Both halves are bounded. A child that hangs ANSWERING `shutdown` never
      // reaches the exit wait, so a fallback guarding only the exit leaves
      // teardown able to hang for as long as the test runner allows.
      await bounded(connection.sendRequest(ShutdownRequest.type, undefined));
      await bounded(Promise.resolve(connection.sendNotification(ExitNotification.type)));
      // Dispose the connection first so the reader stops holding stdout open,
      // then wait for the child to fully close (exit AND stdio drain), so no
      // lingering handle outlives the test.
      connection.dispose();
      const exitCode = await new Promise<number | null>(resolve => {
         if (child.exitCode !== null || child.signalCode !== null) {
            resolve(child.exitCode);
            return;
         }
         const killTimer = setTimeout(() => {
            if (child.exitCode === null) {
               child.kill('SIGKILL');
            }
         }, killTimeoutMs);
         child.once('close', code => {
            clearTimeout(killTimer);
            resolve(code);
         });
      });
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      return exitCode;
   }

   const server: SpawnedServer = {
      connection,
      pid: child.pid,
      initializeResult,
      diagnostics,
      logMessages,
      stderr: () => stderrBuf,
      async port(command: string, portOptions: PortLookupOptions = {}): Promise<number> {
         const attempts = portOptions.attempts ?? 40;
         const intervalMs = portOptions.intervalMs ?? 100;
         for (let attempt = 0; attempt < attempts; attempt++) {
            const answer = await connection.sendRequest<number | undefined>(command).catch(() => undefined);
            if (typeof answer === 'number' && answer > 0) {
               return answer;
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
         }
         throw new Error(`No port published for LSP request "${command}" after ${attempts} attempts`);
      },
      nextDiagnostics(uri: string, timeoutMsOrOptions?: number | NextDiagnosticsOptions): Promise<Diagnostic[]> {
         const nextOptions: NextDiagnosticsOptions =
            typeof timeoutMsOrOptions === 'number' ? { timeoutMs: timeoutMsOrOptions } : (timeoutMsOrOptions ?? {});
         const timeoutMs = nextOptions.timeoutMs ?? RESPONSE_TIMEOUT_MS;
         const { fromIndex } = nextOptions;
         if (fromIndex !== undefined) {
            // Replay from the capture first: the publish this call asks about may
            // already have arrived, and a waiter only ever sees later ones.
            const captured = diagnostics.slice(Math.max(0, fromIndex)).find(params => params.uri === uri);
            if (captured) {
               return Promise.resolve(captured.diagnostics);
            }
         }
         return new Promise<Diagnostic[]>((resolve, reject) => {
            const notify = (params: PublishDiagnosticsParams): void => {
               if (params.uri !== uri) {
                  return;
               }
               clearTimeout(timer);
               waiters.delete(notify);
               resolve(params.diagnostics);
            };
            const timer = setTimeout(() => {
               waiters.delete(notify);
               const seen = diagnostics.slice(fromIndex ?? 0).map(params => params.uri);
               reject(new Error(`Timed out waiting for diagnostics for ${uri}; published since: ${seen.join(', ') || '(nothing)'}`));
            }, timeoutMs);
            waiters.add(notify);
         });
      },
      dispose(): Promise<number | null> {
         liveServers.delete(server);
         disposal ??= terminate();
         return disposal;
      }
   };
   liveServers.add(server);
   return server;
}
