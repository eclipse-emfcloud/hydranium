/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Server-only entry (`@hydranium/core/node`). Everything reachable from here may
// pull `node:*`; the portable `.` barrel must NOT. Anything exported here is
// "server-only" by contract — adopters building for the browser import `.` only.
//
// Node hosts get the log file-tee for free: importing this entry installs the
// `node:fs`-backed sink (see `installNodeLogFileSink`) at module load, before
// the first logger is constructed. The function is re-exported for explicit
// control / tests.
// Node hosts also get workspace-write-lock reentrancy detection for free, by the
// same mechanism and for the same reason: the check needs `node:async_hooks`, so
// the neutral tree can only declare the seam.
import { installNodeLogFileSink } from './log-file-sink.js';
import { installNodeWriteLockScope } from './write-lock-scope-node.js';

export * from './node-file-system-provider.js';
export * from './log-file-sink.js';
export * from './write-lock-scope-node.js';
export * from './log-preamble-node.js';
export * from './server-diagnostics.js';

// Node-only headless tools, diagnostics and launchers — pure `node:*` modules
// that physically live under `src/node/` (the server-only tree). The real-path
// document-identity policy is deliberately NOT among them: the `realpath`
// syscall is delegated to the Node `FileSystemProvider`, which leaves
// `RealpathDocumentUriPolicy` browser-neutral, so it ships from the portable
// entry alongside the default policy.
export * from './ast-ground-truth.js';
export * from './event-loop-monitor.js';
export * from './latency-from-env.js';
export * from './measure-memory.js';
export * from './memory-monitor.js';
export * from './lint-grammar.js';
export * from './process-memory.js';
export * from './profile-capture.js';
export * from './profile-digest.js';
export * from './profiling-run.js';
export * from './reflect-grammar.js';
export * from './server-state-snapshot.js';
export * from './socket-launcher.js';
export * from './stdio-launcher.js';
export * from './validate-workspace.js';

installNodeLogFileSink();
installNodeWriteLockScope();
