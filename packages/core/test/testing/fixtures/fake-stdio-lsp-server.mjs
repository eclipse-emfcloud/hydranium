#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A minimal JSON-RPC peer speaking just enough LSP for the subprocess harness's
 * own tests, spawned as a real child process.
 *
 * It is deliberately NOT a real head. A test that drives a real server cannot
 * tell a correctly wired harness from a server that would have produced the same
 * observable anyway, and it cannot reach any of the failure modes the harness
 * exists to report — a child that never answers, one that dies mid-handshake,
 * one that leaks a log onto the protocol channel, one that ignores `shutdown`.
 * Each of those is a mode here, selected by `FAKE_LSP_MODE`.
 *
 * Two properties are load-bearing for the tests over it.
 *
 * - **The first publish and log message are sent BEFORE the `initialize`
 *   response.** They therefore reach the wire ahead of the handshake, so a
 *   harness that registered its captures after the handshake loses them. That
 *   race is the whole reason the harness registers before `listen()`.
 * - **It never exits on its own** within any test's horizon: a ref'd interval
 *   holds the event loop, cleared only by the `exit` notification. So an exit
 *   code of 0 means the graceful pair really arrived, and a signalled death
 *   means the fallback really fired. The unref'd backstop below is orders of
 *   magnitude longer than any test's budget, and exists only so a harness bug
 *   cannot leave a process behind forever.
 *
 * Every request is counted before it is answered, and the count is readable over
 * the wire, which is how a test asserts that the harness POLLED rather than
 * asked once, and that the boot asked for no port at all.
 */

import { writeFileSync } from 'node:fs';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

/** Reported in `serverInfo.name`, so a test can tell this fixture answered. */
const FIXTURE_SERVER_NAME = 'fake-stdio-lsp-server';

/** The port `ns/head/port` answers with, once it answers at all. */
const FIXTURE_PORT = 54321;

/** How many requests `ns/head/port` swallows before answering, so a single-shot lookup fails. */
const FIXTURE_PORT_ATTEMPTS = 3;

/** Sent as `window/logMessage` before the handshake completes. */
const FIXTURE_LOG_MESSAGE = 'fake-stdio-lsp-server: booted';

/** Written to stderr on start, so a test sees stderr captured rather than asserted empty. */
const FIXTURE_STDERR_MARKER = 'fake-stdio-lsp-server: on stderr';

/** Written to stdout in `stdout-noise` mode — what a log leaked onto the protocol channel looks like. */
const FIXTURE_STDOUT_NOISE = 'fake-stdio-lsp-server: leaked onto stdout';

/** The URI the pre-handshake publish addresses. */
const FIXTURE_DIAGNOSTIC_URI = 'file:///a.x';

/** Message of the pre-handshake publish, distinct from anything a test provokes later. */
const FIXTURE_FIRST_DIAGNOSTIC = 'first';

/** Nothing here is position-sensitive, so one degenerate range serves every diagnostic. */
const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** Guards against an orphan surviving a harness bug; far past any test's budget. */
const BACKSTOP_MS = 30_000;

function main() {
   const mode = process.env.FAKE_LSP_MODE ?? 'default';
   if (process.env.FAKE_LSP_PID_FILE) {
      // Written before anything can go wrong, so a test can assert the process
      // both started and later died even in the modes that never handshake.
      writeFileSync(process.env.FAKE_LSP_PID_FILE, String(process.pid));
   }
   if (mode === 'stdout-noise') {
      process.stdout.write(`${FIXTURE_STDOUT_NOISE}\n`);
   }
   process.stderr.write(`${FIXTURE_STDERR_MARKER}\n`);

   const keepAlive = setInterval(() => undefined, 1_000);
   setTimeout(() => process.exit(70), BACKSTOP_MS).unref();

   const attempts = new Map();
   let initializeParams;

   const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
   connection.onError(() => undefined);
   connection.onClose(() => undefined);

   connection.onRequest((method, ...params) => {
      attempts.set(method, (attempts.get(method) ?? 0) + 1);
      switch (method) {
         case 'initialize':
            if (mode === 'no-initialize') {
               return new Promise(() => undefined);
            }
            if (mode === 'die-on-initialize') {
               process.exit(3);
            }
            initializeParams = params[0];
            connection.sendNotification('textDocument/publishDiagnostics', {
               uri: FIXTURE_DIAGNOSTIC_URI,
               diagnostics: [{ range: ZERO_RANGE, message: FIXTURE_FIRST_DIAGNOSTIC }]
            });
            connection.sendNotification('window/logMessage', { type: 3, message: FIXTURE_LOG_MESSAGE });
            return { capabilities: { hoverProvider: true }, serverInfo: { name: FIXTURE_SERVER_NAME } };
         case 'probe/initializeParams':
            return initializeParams ?? null;
         case 'probe/attempts':
            return attempts.get(params[0].method) ?? 0;
         case 'probe/publish':
            connection.sendNotification('textDocument/publishDiagnostics', {
               uri: params[0].uri,
               diagnostics: [{ range: ZERO_RANGE, message: params[0].message }]
            });
            return true;
         case 'ns/head/port':
            return (attempts.get(method) ?? 0) >= FIXTURE_PORT_ATTEMPTS ? FIXTURE_PORT : undefined;
         case 'shutdown':
            if (mode === 'ignore-shutdown') {
               return new Promise(() => undefined);
            }
            return null;
         default:
            return undefined;
      }
   });

   connection.onNotification(method => {
      if (method === 'exit' && mode !== 'ignore-shutdown') {
         clearInterval(keepAlive);
         connection.dispose();
         process.exit(0);
      }
   });

   connection.listen();
}

main();
