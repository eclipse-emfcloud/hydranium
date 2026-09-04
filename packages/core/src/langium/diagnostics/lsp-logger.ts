/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   AbstractLogger,
   type Clock,
   DEFAULT_LOG_FILE_ENV,
   DEFAULT_LOG_LEVEL_ENV,
   Logger,
   type LogLevel,
   type LogThreshold,
   ObservableValue,
   type MaybeObservableValue,
   parseLogLevel
} from '@hydranium/protocol';
import { type URI } from '@hydranium/langium';
import type { Connection } from 'vscode-languageserver';
import { type ServerSharedServices } from '../module.js';
import { setLogFilePath, teeLogLine } from './logger.js';
import { processEnv, writeStderr } from '../../util/environment.js';

/**
 * Guards the one-time env-var log-level and log-file baselines (see the
 * {@link LspLogger} constructor). Applied on the first logger construction and
 * never again, so derived child loggers cannot re-read the env and clobber a
 * live setting.
 */
let envBaselineApplied = false;

/**
 * Options accepted by {@link LspLogger}. Carries the logger's own
 * identity {@link component} (the field on {@link AbstractLogger}
 * prefixed to every log line the logger emits). This is intentionally
 * a separate field from `logName` on
 * `LogNameOptions` — the latter labels a
 * service that DERIVES a logger; this labels the logger itself.
 */
export interface LspLoggerOptions {
   /** Component label prefixed to log output. Read by `AbstractLogger.emit`. */
   readonly component?: string;
   /**
    * Process-global log threshold, applied at construction of the ROOT logger
    * (the instance bound in DI). When set, the constructor calls
    * `Logger.setLevel` with the current value (only when truthy, so an unset
    * setting leaves the env-fallback / `'info'` default in place) and
    * re-applies on every `onChange`. Bind to a user setting via
    * `Settings.value`.
    *
    * The threshold is GLOBAL, not per-instance: `derive` / `for` create child
    * loggers passing only `component`, so children never carry or re-apply
    * `logThreshold` — the root owns it. Pass a constant for tests / non-LSP
    * runs. (Named `logThreshold`, not `logLevel`, to avoid colliding with
    * GLSP's per-instance numeric `Logger.logLevel`; it is an
    * `MaybeObservableValue<LogThreshold>`, matching the framework's filter-side type.)
    */
   readonly logThreshold?: MaybeObservableValue<LogThreshold | undefined>;
}

/**
 * LSP-bound implementation of {@link Logger}. Forwards messages to the
 * language client via the connection bound in {@link ServerSharedServices}.
 * Emission only — memory readout and timing live on the server's
 * `ServerTracer`, which composes this
 * logger. Adds URI-aware labelling on top of {@link AbstractLogger}.
 *
 * `withUri` renders workspace-relative paths by default (via the framework
 * `WorkspaceManager.wsRelativePath`); consumers subclass only for a different
 * display convention or extra language-specific helpers.
 */
export class LspLogger extends AbstractLogger implements Logger {
   constructor(
      protected readonly services: ServerSharedServices,
      options: LspLoggerOptions = {}
   ) {
      super(options.component);
      // Apply the framework env baselines (`HYDRANIUM_LOG_LEVEL` and
      // `HYDRANIUM_LOG_FILE`) exactly once, on the first logger construction,
      // before any setting is read. Unconditional and process-global, so it
      // needs no root detection and is never re-applied by derived children —
      // which would otherwise clobber a live setting. These are the single env
      // vars for level / file-tee (an adopter brands them by renaming the
      // framework env, not by introducing its own).
      if (!envBaselineApplied) {
         envBaselineApplied = true;
         // No `process.env` in a browser — the level/file-tee env baseline is
         // a Node concern; skip it cleanly there.
         const env = processEnv();
         if (env) {
            const envLevel = parseLogLevel(env[DEFAULT_LOG_LEVEL_ENV]);
            if (envLevel) {
               Logger.setLevel(envLevel);
            }
            const envLogFile = env[DEFAULT_LOG_FILE_ENV];
            if (envLogFile) {
               setLogFilePath(envLogFile);
            }
         }
      }
      // Apply the configured threshold from the root logger only — `derive`
      // passes just `component`, so children never carry `logThreshold`. The
      // setting overrides the env baseline above and re-applies on every change;
      // truthy-guarded so an unset setting leaves the baseline / `'info'` default.
      if (options.logThreshold !== undefined) {
         const level = ObservableValue.from(options.logThreshold);
         if (level.value) {
            Logger.setLevel(level.value);
         }
         level.onChange(next => {
            if (next) {
               Logger.setLevel(next);
            }
         });
      }
   }

   /**
    * Route logger timing and timestamps through the injected framework
    * {@link Clock} (the dedicated `shared.Clock` slot) so server-side log time
    * shares the one fake-clock axis tests drive with `makeFakeClock`, rather
    * than reading the wall clock directly. The logger takes the full
    * {@link ServerSharedServices}, which carries the slot, so the read is
    * direct — no cast or fallback needed.
    */
   protected override clock(): Clock {
      return this.services.Clock;
   }

   /**
    * URI labelling rendered as a workspace-relative path via the framework
    * `HydraniumWorkspaceManager.wsRelativePath` (falls back to the URI
    * string when no workspace folder is known). Widens the
    * {@link Logger.withUri} parameter to accept a `URI` object directly —
    * server-side callers typically hold URIs, not strings. Subclasses with a
    * different display convention override their `WorkspaceManager.wsRelativePath`
    * (preferred) or this method.
    */
   override withUri(uri: URI | string): this {
      return this.with(this.services.workspace.WorkspaceManager.wsRelativePath(uri));
   }

   protected emit(level: LogLevel, label: string, message: string, args: readonly unknown[]): void {
      const component = this.component ? ` [${this.component}]` : '';
      // Pad to the widest label (5 chars — 'Error'/'Debug'/'Trace') so timestamps line up.
      const prefix = `[${label.padEnd(5)} - ${this.timestamp()}]${component}`;
      const combined = args.length === 0 ? message : `${message} ${args.map(formatLogArg).join(' ')}`;
      const formatted = `${prefix} ${combined}`;
      const connection = this.services.lsp.Connection;
      // Route through the LSP `window/logMessage` channel so log lines stay
      // framed as JSON-RPC messages even in `--stdio` mode (where stdout is
      // the LSP transport — any raw `console.*` write before
      // vscode-languageserver's `attachConsole` patches the globals would
      // corrupt the protocol stream). Pre-stringify all args into one
      // message because `RemoteConsole.*` takes a single string.
      //
      // Falls through to the raw sink below when the connection cannot take the
      // line, which is NOT a theoretical case: `RemoteConsole.send` throws
      // `Connection is disposed` once the client has gone, and the log lines
      // most likely to arrive at that moment are the ones that matter most —
      // shutdown diagnostics and the workspace manager's own
      // unhandled-rejection handler. A log sink that throws turns a diagnostic
      // into a crash, so a dead channel degrades to stderr instead.
      if (!connection || !sendViaConnection(connection, level, formatted)) {
         if (!writeStderr(`${formatted}\n`)) {
            // Browser only. In Node every level goes to STDERR, including the
            // three that `console.*` would put on stdout (`info` / `debug` /
            // `log`) — stdout is the JSON-RPC channel for any head launched over
            // stdio, so a log line written there corrupts the protocol stream
            // rather than merely appearing in the wrong place. A browser has no
            // such channel, so it keeps the per-level console methods, which
            // render structured args far better than a pre-joined string.
            const consumer = CONSOLE[level];
            consumer(prefix, message, ...args);
         }
      }
      // File-tee fan-out for headless capture (see `setLogFilePath`). Always runs
      // in addition to the LSP/console sink — log sinks fan out, they don't replace.
      teeLogLine(formatted);
   }

   protected derive(component: string): this {
      const Subclass = this.constructor as new (services: ServerSharedServices, options?: LspLoggerOptions) => this;
      return new Subclass(this.services, { component });
   }
   // note: `derive` uses the logger's own `component` field, not the
   // service `logName` option — the field on AbstractLogger IS named `component`.
}

/**
 * Deliver one formatted line over the LSP `window/logMessage` channel,
 * reporting whether the channel took it.
 *
 * Returns `false` — rather than throwing — when the connection is closed or
 * disposed. `RemoteConsole.send` throws `Connection is disposed` in that state,
 * and a logger that propagates it converts a diagnostic into an uncaught
 * exception at exactly the moment things are already going wrong: the framework's
 * own `handleProcessUnhandledRejection` logs through this path, so a late
 * rejection after client teardown would crash the server while *reporting* an
 * error. The caller falls back to the raw sink, so the line is still delivered.
 */
function sendViaConnection(connection: Connection, level: LogLevel, formatted: string): boolean {
   try {
      LSP_CONSOLE[level](connection)(formatted);
      return true;
   } catch {
      return false;
   }
}

/**
 * Per-level console adapter, used **only where there is no `process.stderr`**
 * (a browser). In Node the fallback writes to stderr for every level instead —
 * see the `emit` branch. Kept per-level rather than collapsed onto
 * `console.error` because devtools render `info` / `debug` distinctly and
 * colouring every framework log line as an error would be actively misleading.
 */
const CONSOLE: Record<LogLevel, (...args: unknown[]) => void> = {
   error: console.error,
   warn: console.warn,
   info: console.info,
   debug: console.debug,
   trace: console.log
};

/**
 * Per-level adapter that resolves the right `RemoteConsole` method on a
 * Langium {@link Connection}. `RemoteConsole` exposes
 * `error / warn / info / log / debug` — `debug` arriving with LSP 3.18's
 * `MessageType.Debug` severity, so a debug line is now tagged as such in
 * the client's log instead of being indistinguishable from `log`. There is
 * still no `trace`, so that one level folds into `log` (severity `Log` in
 * the `window/logMessage` type table). A client predating 3.18 has no
 * `Debug` case and appends the message unlabelled, so the mapping degrades
 * rather than dropping output. The returned function takes a single
 * pre-formatted string since `RemoteConsole.*` accepts only one argument.
 */
const LSP_CONSOLE: Record<LogLevel, (connection: Connection) => (message: string) => void> = {
   error: c => c.console.error.bind(c.console),
   warn: c => c.console.warn.bind(c.console),
   info: c => c.console.info.bind(c.console),
   debug: c => c.console.debug.bind(c.console),
   trace: c => c.console.log.bind(c.console)
};

/**
 * Render a logger-argument value into the single combined string the LSP
 * `window/logMessage` channel takes. Mirrors how raw `console.*` would
 * format multiple args, but with explicit handling for Errors (stack) and
 * objects (JSON).
 */
function formatLogArg(value: unknown): string {
   if (value === undefined) {
      return 'undefined';
   }
   if (value === null) {
      return 'null';
   }
   if (typeof value === 'string') {
      return value;
   }
   if (value instanceof Error) {
      return value.stack ?? value.message;
   }
   if (typeof value === 'object') {
      try {
         return JSON.stringify(value);
      } catch {
         return String(value);
      }
   }
   return String(value);
}
