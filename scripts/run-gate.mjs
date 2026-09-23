#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The gate's verdict line.
 *
 * npm prints nothing of its own when a `run` script exits non-zero, and that is
 * deliberate rather than a quirk: its error formatter classifies `run-script` as
 * a shellout and suppresses the message, on the reasoning that whatever it
 * shelled out to has already said its piece. The reasoning holds for one command
 * and breaks for a chain of them. An `&&` chain of `npm run` clauses therefore
 * states its verdict ONLY in its exit code — the last words in a capture belong
 * to whichever clause failed, in that clause's own vocabulary, and nothing
 * anywhere names the run as a whole.
 *
 * What that costs is not silence but CONTRADICTION. A tail clause reddening
 * after turbo has printed `Tasks: N successful, N total` leaves that success
 * line as the only summary-shaped thing in the capture, so a reader grepping for
 * one is told the opposite of the truth — and the exit code they would have to
 * consult instead is exactly what a log, a scrollback or a pasted excerpt does
 * not carry.
 *
 * So the chain runs from here, and every run ends in one line that says which
 * way it went. Three properties of that line are the point:
 *
 * - **It is printed on BOTH paths.** A marker that appears only on failure
 *   cannot be told apart from a run cut short before reaching it, which is the
 *   same ambiguity one level up.
 * - **It goes to STDOUT, including the failing one.** A diagnostic belongs on
 *   stderr, but a verdict is a result, and the capture shapes that lose a
 *   failure are the ones keeping stdout alone: a pipe carries no stderr unless
 *   the caller redirects it.
 * - **It names the clause and its position.** "The gate failed" sends a reader
 *   back through the whole capture; a named clause, with whatever went unrun
 *   after it, says where to look and how far the run got.
 *
 * The clause list is an ARGUMENT rather than something this script knows,
 * because `check:gate-targets` asserts that the two gates are assembled from the
 * declared halves and nothing else. It can only do that while the assembly is
 * still written in the manifest it reads.
 *
 * Usage: node scripts/run-gate.mjs <script> [<script>...]
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const clauses = process.argv.slice(2);

/**
 * A signal is NOTED rather than obeyed, so an interrupted run still ends in a
 * verdict rather than in a capture that simply stops. The handler cannot run
 * while a clause is in flight — `spawnSync` holds the thread — but the clause
 * shares this process group and receives the same signal, so an interruption
 * surfaces as that clause's `signal` and this flag catches only the narrow
 * window between two clauses.
 */
let interruptedBy;
for (const signal of ['SIGINT', 'SIGTERM']) {
   process.on(signal, () => {
      interruptedBy = signal;
   });
}

/**
 * npm through its own cli entry point rather than the `npm` on PATH: on windows
 * — where `check:platform` runs — that name resolves to a `.cmd` shim, which
 * `spawnSync` cannot execute without handing the command line to a shell and
 * inheriting its quoting rules.
 */
const npmCli = process.env.npm_execpath;
function runClause(clause) {
   const options = { cwd: REPO_ROOT, stdio: 'inherit' };
   return npmCli
      ? spawnSync(process.execPath, [npmCli, 'run', clause], options)
      : spawnSync('npm', ['run', clause], { ...options, shell: process.platform === 'win32' });
}

/** One blank line ahead of it, so the verdict is not read as the last clause's own output. */
function verdict(line) {
   console.log('');
   console.log(line);
}

function fail(line, exitCode) {
   verdict(`✗ GATE FAILED — ${line}`);
   process.exit(exitCode);
}

if (clauses.length === 0) {
   fail('no clause was named, so this run gated nothing.', 1);
}

// `npm run check -- --whatever` appends to THIS argv, and `npm run --whatever`
// with no script left to name lists the scripts and exits 0 — a gate that
// passed without running. `check:gate-targets` rejects a flag written into the
// manifest; this rejects one that arrives at the call.
const malformed = clauses.find(clause => !/^[\w:-]+$/.test(clause) || clause.startsWith('-'));
if (malformed) {
   fail(`\`${malformed}\` is not a script name, so this run gated nothing.`, 1);
}

console.log(`gate: ${clauses.join(' then ')} — one verdict line closes this run, and its absence means the run was cut short.`);

for (const [index, clause] of clauses.entries()) {
   const position = `clause ${index + 1} of ${clauses.length}`;
   const remaining = clauses.slice(index + 1);
   const untouched = remaining.length > 0 ? ` Not reached: ${remaining.join(', ')}.` : '';
   const result = runClause(clause);

   if (result.error) {
      fail(`\`${clause}\` (${position}) could not be started: ${result.error.message}.${untouched}`, 1);
   }
   if (result.signal) {
      fail(`\`${clause}\` (${position}) was killed by ${result.signal}.${untouched}`, 1);
   }
   if (result.status !== 0) {
      fail(`\`${clause}\` (${position}) exited ${result.status}.${untouched}`, result.status);
   }
   if (interruptedBy) {
      fail(`interrupted by ${interruptedBy} after \`${clause}\` (${position}).${untouched}`, 1);
   }
}

verdict(`✓ GATE PASSED — ${clauses.join(', ')}.`);
