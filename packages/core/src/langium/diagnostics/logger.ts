/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format } from '@hydranium/protocol';
import { currentMemoryUsage, onProcessEvent, processPid } from '../../util/environment.js';

/** Only append a memory suffix when the heap has moved by at least this much since the last log line. */
export const MEMORY_DELTA_BYTES = 5 * 1024 * 1024;

/**
 * Pluggable file-tee sink. The file-tee's only platform coupling is the
 * actual disk write + directory create; routing those through an injected
 * sink keeps this module free of `node:fs` so it stays on the portable `.`
 * entry. `@hydranium/core/node` installs a `node:fs`-backed sink (see
 * `installNodeLogFileSink`); when
 * no sink is installed (browser / in-memory hosts) the file-tee is inert and
 * lines fan out only to the LSP/console destination. Configuring a tee target
 * (`HYDRANIUM_LOG_FILE`) is itself Node-only, so the inert path is never hit
 * in a browser.
 */
export interface LogFileSink {
   /** Append already-formatted text to the file at `path`. Must not throw. */
   append(path: string, data: string): void;
   /** Best-effort create of the parent directory for `path`. Must not throw. */
   ensureDir(path: string): void;
}

let fileSink: LogFileSink | undefined;

/** Install (or clear, with `undefined`) the file-tee sink. Idempotent. */
export function setLogFileSink(sink: LogFileSink | undefined): void {
   fileSink = sink;
}

/**
 * File-tee state for `LspLogger`'s emit. When
 * non-empty, every formatted log line is appended to the path in addition to
 * its LSP `window/logMessage` / console destination (see {@link teeLogLine}).
 * Diagnostic surface only — once the LSP connection binds, server logs route
 * through `connection.console.*` and disappear from any pipe watching backend
 * stdout; setting this path makes them visible to a headless test harness
 * without scraping the client's Output view.
 *
 * The sink writes synchronously, so log lines preserve emission order; errors
 * are swallowed because a failing log sink must not propagate.
 * Append-only — the path is the consumer's responsibility to truncate / rotate.
 *
 * Raw configured target — may contain `{placeholder}` tokens (e.g.
 * `{workspace}`) that are not known at module-load time.
 */
let logFileTemplate: string | undefined;
/** Fully-resolved target (no remaining placeholders). `undefined` while pending. */
let resolvedLogFilePath: string | undefined;
/** Placeholder values supplied so far via {@link resolveLogFilePlaceholder}. */
const logFilePlaceholders = new Map<string, string>();
/**
 * Lines emitted while the target is still pending (placeholders unresolved).
 * Flushed verbatim — preserving emission order — once the target resolves, so
 * no startup line is ever dropped. Each entry already carries its trailing `\n`.
 */
const pendingLogLines: string[] = [];

/** Matches any remaining `{name}` placeholder token. */
const PLACEHOLDER_PATTERN = /\{[^}]+\}/;

/**
 * Recompute {@link resolvedLogFilePath} from the template + known placeholders.
 * Resolves (and flushes the pending buffer) only once no `{...}` token remains.
 */
function tryResolveLogFilePath(): void {
   if (!logFileTemplate) {
      resolvedLogFilePath = undefined;
      return;
   }
   let path = logFileTemplate;
   for (const [name, value] of logFilePlaceholders) {
      path = path.split(`{${name}}`).join(value);
   }
   if (PLACEHOLDER_PATTERN.test(path)) {
      resolvedLogFilePath = undefined;
      // Target is pending — guarantee the buffer is flushed even if the process
      // exits before the remaining placeholders are ever supplied.
      ensureFallbackHandler();
      return;
   }
   resolvedLogFilePath = path;
   ensureLogDir(path);
   flushPendingLogLines();
}

/**
 * Best-effort create of the target's parent directory. Covers the headless-test
 * case where the runner wipes the output directory before the server writes its
 * log under it. Failures are swallowed — a log sink must never propagate.
 */
function ensureLogDir(filePath: string): void {
   // No-op when no sink is installed (browser); the Node sink swallows its own errors.
   fileSink?.ensureDir(filePath);
}

/** Append the buffered lines to the resolved target, then clear the buffer. */
function flushPendingLogLines(): void {
   if (!resolvedLogFilePath || pendingLogLines.length === 0) {
      return;
   }
   fileSink?.append(resolvedLogFilePath, pendingLogLines.join(''));
   pendingLogLines.length = 0;
}

/**
 * Set the file-tee target programmatically. Pass `undefined` to disable. The
 * path may contain `{placeholder}` tokens (e.g. `{workspace}`); lines buffer
 * until every token is supplied via {@link resolveLogFilePlaceholder}.
 * Called by the `LspLogger` constructor's
 * one-time `HYDRANIUM_LOG_FILE` env baseline (and by tests).
 */
export function setLogFilePath(path: string | undefined): void {
   logFileTemplate = path && path.length > 0 ? path : undefined;
   logFilePlaceholders.clear();
   pendingLogLines.length = 0;
   resolvedLogFilePath = undefined;
   tryResolveLogFilePath();
}

/**
 * Supply a value for a `{name}` placeholder in the configured target. Once the
 * last placeholder is supplied the target resolves and any lines buffered while
 * it was pending are flushed in emission order.
 */
export function resolveLogFilePlaceholder(name: string, value: string): void {
   logFilePlaceholders.set(name, value);
   tryResolveLogFilePath();
}

/**
 * Last-resort flush for the case where the target never resolves (e.g. the
 * server crashed before the workspace was known). Substitutes any remaining
 * `{...}` token with a process-unique `_startup-<pid>` segment and flushes the
 * buffer, so startup / failure lines are never lost. No-op when the target is
 * already resolved or there is nothing buffered. Registered on `process.exit`
 * as soon as an unresolved target is configured.
 */
export function flushLogFileFallback(): void {
   if (!logFileTemplate || resolvedLogFilePath || pendingLogLines.length === 0) {
      return;
   }
   resolvedLogFilePath = logFileTemplate.replace(/\{[^}]+\}/g, `_startup-${processPid() ?? 'unknown'}`);
   ensureLogDir(resolvedLogFilePath);
   flushPendingLogLines();
}

/** Registered at most once; flushes any pending buffer on process teardown. */
let fallbackHandlerRegistered = false;
function ensureFallbackHandler(): void {
   if (fallbackHandlerRegistered) {
      return;
   }
   fallbackHandlerRegistered = true;
   // Node-only teardown flush; a no-op in a browser worker (no `exit` event).
   onProcessEvent('exit', () => flushLogFileFallback());
}

/** Current resolved file-tee target. `undefined` when disabled or still pending. */
export function getLogFilePath(): string | undefined {
   return resolvedLogFilePath;
}

/**
 * Fan a single already-formatted log line out to the file-tee target, if one is
 * configured. Called by `LspLogger`'s emit in
 * addition to the LSP/console sink — log sinks fan out, they don't replace.
 * While the target is still pending (unresolved `{placeholder}`), the line is
 * buffered instead of dropped.
 */
export function teeLogLine(formatted: string): void {
   if (!logFileTemplate) {
      return;
   }
   const line = `${formatted}\n`;
   if (resolvedLogFilePath) {
      // The sink swallows its own errors; recursing into the logger here would
      // re-enter emit and loop. The LSP/console sink already delivered the line.
      fileSink?.append(resolvedLogFilePath, line);
   } else {
      pendingLogLines.push(line);
   }
}

// Re-exported so the token derivation is reachable from the diagnostics barrel.
// It is defined in a standalone, dependency-light module so a Playwright test
// helper can import it directly without pulling the barrel's module graph.
export { toLogFileWorkspaceToken } from './log-file-token.js';

/**
 * Shared options-base for every framework-bound service that derives a
 * `Tracer` (or
 * `Logger`) from its `services`
 * constructor parameter. Carries the `logName` label used to identify the
 * service in its log / trace output and in the startup instantiation trace.
 *
 * The field name reads from the adopter's perspective — `logName` is "the
 * name this service appears under in the log". Distinct from
 * `LspLoggerOptions.component`, which is the logger's own identity field
 * (matches `AbstractLogger.component` and `Logger.for`'s argument).
 *
 * A framework service's constructor stores a tracer named by `logName` and
 * emits a single instantiation trace. The fallback used when `logName` is
 * absent is chosen per service: a fixed curated string where the slot has one
 * canonical implementation, or `this.constructor.name` where it has swappable
 * strategy bindings, so the log shows which implementation ran. The
 * framework's default `Logger` level is `'info'`, so those trace lines are
 * no-ops in production; raising the level to `trace` — directly or via the
 * LSP-config-bound setting — before workspace load makes startup
 * instantiation visible.
 */
export interface LogNameOptions {
   /**
    * Name passed to `Tracer.for(...)` / `Logger.for(...)` — the label the
    * service appears under in its log / trace output. Optional; each
    * service supplies its own default (a fixed curated string, or
    * `this.constructor.name`). Override when the runtime class name is
    * generic (anonymous adopter subclass) or when multiple instances of
    * the same class are bound to distinct slots and the adopter wants to
    * disambiguate them in the log.
    */
   readonly logName?: string;
}

/**
 * Format current memory as "heap used/total, rss N". Returns `''` where
 * `process.memoryUsage` is unavailable (browser) so callers can append it
 * unconditionally.
 */
export function formatMemory(): string {
   const mem = currentMemoryUsage();
   if (!mem) {
      return '';
   }
   return `heap ${Format.bytes(mem.heapUsed)}/${Format.bytes(mem.heapTotal)}, rss ${Format.bytes(mem.rss)}`;
}
