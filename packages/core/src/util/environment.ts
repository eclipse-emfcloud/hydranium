/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The single home for Node-global access in neutral (`.`-entry) code. Neutral
// code never touches `process` / `Buffer` directly (enforced by the eslint
// `no-restricted-globals` ban, whose only neutral exemption is this module); it
// goes through these guarded accessors so it degrades cleanly in a browser.
//
// Capability-detected, NOT environment-detected: bundlers inject a partial
// `process` shim into browser builds (Theia's browser-app has `process.env` but
// no `process.memoryUsage` / `fs`), so `typeof process` alone is not a reliable
// "am I in Node" check. Each accessor only claims the specific API it tests.

/** `process.env` when a Node `process` exposes it, else `undefined`. */
export function processEnv(): NodeJS.ProcessEnv | undefined {
   return typeof process !== 'undefined' && process.env ? process.env : undefined;
}

/** `process.pid` when available, else `undefined` (browser). */
export function processPid(): number | undefined {
   return typeof process !== 'undefined' ? process.pid : undefined;
}

/**
 * Whether the host filesystem treats paths case-insensitively — `true` on
 * Windows and macOS, `false` on Linux and in a browser.
 *
 * Capability cannot be detected without touching the filesystem, so this reads
 * `process.platform` and answers `false` when there is none. That default is
 * the safe one: folding case where the filesystem does NOT would make two
 * genuinely distinct files collide, which is a correctness bug, whereas failing
 * to fold merely misses an optimisation.
 */
export function isCaseInsensitiveFileSystem(): boolean {
   const platform = typeof process !== 'undefined' ? process.platform : undefined;
   return platform === 'win32' || platform === 'darwin';
}

/** Node `process` lifecycle / error / signal events accepted by {@link onProcessEvent}. */
export type ProcessEvent =
   'exit' | 'beforeExit' | 'uncaughtException' | 'unhandledRejection' | 'rejectionHandled' | 'warning' | 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/**
 * Register a process lifecycle handler (`'exit'`, `'unhandledRejection'`, …) if
 * a Node `process` with `on` is present; a no-op in a browser worker (no
 * `process`, no such events).
 */
export function onProcessEvent(event: ProcessEvent, handler: (...args: unknown[]) => void): void {
   if (typeof process !== 'undefined' && typeof process.on === 'function') {
      process.on(event, handler);
   }
}

/**
 * Write already-formatted text to the process's standard error, when a
 * Node-like `process` exposes one. Returns `true` when the text was written and
 * `false` in a browser, so a caller can fall back to `console.*`.
 *
 * Exists because **a server's stdout is a data channel, not a log channel**: an
 * LSP or data-server head launched over stdio carries JSON-RPC frames on
 * stdout, so a log line written there corrupts the protocol stream. `stderr` is
 * the diagnostics channel by the same convention, and is the stream a parent
 * process inherits when it spawns a head as a child.
 */
export function writeStderr(text: string): boolean {
   if (typeof process === 'undefined' || !process.stderr || typeof process.stderr.write !== 'function') {
      return false;
   }
   process.stderr.write(text);
   return true;
}

/**
 * `process.memoryUsage()` guarded for non-Node hosts — `undefined` in a browser
 * (where a partial `process` shim has no `memoryUsage`).
 */
export function currentMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } | undefined {
   if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') {
      return undefined;
   }
   return process.memoryUsage();
}
