/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogThreshold = 'off' | LogLevel;

export const LEVEL_ORDER: Record<LogThreshold, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/** Default labels rendered in the log line, padded to 5 chars so timestamps line up across sources. */
export const LEVEL_LABELS: Record<LogLevel, string> = {
   error: 'Error',
   warn: 'Warn',
   info: 'Info',
   debug: 'Debug',
   trace: 'Trace'
};

/** Module-global threshold; shared by every `AbstractLogger` instance so derived child
 *  loggers pick up live updates without each having to subscribe to a configuration source. */
let currentLevel: LogThreshold = 'info';

/**
 * Cross-side public logger contract. Every consumer of the framework — browser
 * client extensions, LSP servers, headless CLIs, tests — programs against this
 * interface; concrete implementations supply platform-specific delivery
 * (`AbstractLogger` is the abstract base class that satisfies this contract).
 *
 * Global threshold configuration lives on the {@link Logger} namespace
 * (`Logger.setLevel(...)`, `Logger.getLevel()`, `Logger.isLevelEnabled(...)`).
 *
 * Every emit returns this logger so calls can chain (`logger.error(a).debug(b)`),
 * and every `for` / `sub` / `with` derivation preserves the implementation type.
 */
export interface Logger {
   /** Log a message at error level. */
   error(message?: string, ...args: unknown[]): this;
   /** Log a message at warn level. */
   warn(message?: string, ...args: unknown[]): this;
   /** Log a message at info level. */
   info(message?: string, ...args: unknown[]): this;
   /** Log a message at debug level. */
   debug(message?: string, ...args: unknown[]): this;
   /** High-volume diagnostic lines, only emitted at the `'trace'` threshold. */
   trace(message?: string, ...args: unknown[]): this;
   /** Log a message at info-level threshold with a `Log` label (rather than `Info`). */
   log(message?: string, ...args: unknown[]): this;
   /** Derive a child logger with `component` as a `Foo :: bar`-style suffix. */
   for(component: string): this;
   /** Derive a child logger by deepening the existing `Foo :: bar :: baz` chain. */
   sub(component: string): this;
   /** Derive a child logger appending `component` as a separate bracket: `[a] [b]`. */
   with(component: string): this;
   /**
    * Derive a child logger labelled with the given URI string. Default behaviour
    * appends the URI as a bracket via {@link with}; subclasses with workspace
    * awareness override to display workspace-relative paths. Subclasses MAY
    * widen the parameter type to accept URI objects directly (TypeScript method
    * parameter bivariance permits this) — callers typed against the {@link Logger}
    * interface stringify their URI at the call site.
    */
   withUri(uri: string): this;
   /**
    * Emit `message` at `threshold`, or do nothing when `threshold === 'off'`.
    * Lets a caller holding a {@link LogThreshold} emit without a hand-written
    * `if (level === 'off') return` guard.
    */
   logAt(threshold: LogThreshold, message: string): this;
}

/**
 * Companion namespace for the {@link Logger} interface holding global
 * threshold configuration.
 *
 * The threshold is process-wide: every {@link Logger} instance shares one
 * value, so adopters don't have to wire it through each logger they
 * construct. The timing facilities that build on a logger — `Tracer.time` /
 * `Tracer.startTimer` — consult {@link Logger.isLevelEnabled} internally to
 * short-circuit when the configured level suppresses output.
 */
export namespace Logger {
   /** Set the process-wide log threshold. Every {@link Logger} instance picks up the new value live. */
   export function setLevel(level: LogThreshold): void {
      currentLevel = level;
   }
   /** Read the current process-wide log threshold. */
   export function getLevel(): LogThreshold {
      return currentLevel;
   }
   /**
    * Whether a message at `level` would be emitted at the current threshold.
    * Use to guard expensive log-line construction:
    * `if (Logger.isLevelEnabled('trace')) logger.trace(buildPayload())`.
    */
   export function isLevelEnabled(level: LogLevel): boolean {
      return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
   }
   /**
    * Whether a message at `threshold` would be emitted: `false` for `'off'`,
    * otherwise tracks {@link isLevelEnabled}. Use to gate work behind a
    * {@link LogThreshold} (which {@link isLevelEnabled} cannot accept).
    */
   export function isThresholdEnabled(threshold: LogThreshold): boolean {
      return threshold !== 'off' && isLevelEnabled(threshold);
   }
}

/** True when `value` is one of `'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace'`. */
export function isLogThreshold(value: unknown): value is LogThreshold {
   return typeof value === 'string' && value in LEVEL_ORDER;
}

/**
 * Parse a string-typed configuration value into a {@link LogThreshold}, returning
 * `undefined` for unset or invalid inputs. Case-insensitive — `'WARN'` / `'warn'`
 * / `'Warn'` all normalise to `'warn'`. Use to consume LSP / env-var / CLI inputs
 * without exposing callers to the case-fold detail.
 */
export function parseLogLevel(value: unknown): LogThreshold | undefined {
   const normalised = typeof value === 'string' ? value.toLowerCase() : undefined;
   return normalised && isLogThreshold(normalised) ? normalised : undefined;
}

/**
 * Names of the environment variables the server consults for its launch-time
 * log configuration. They live in the shared protocol layer because they are
 * the *contract* between whoever launches a server (the CLI, a test harness, a
 * container) and the server that reads them — both sides reference one constant
 * instead of duplicating the literal string.
 */
export const DEFAULT_LOG_LEVEL_ENV = 'HYDRANIUM_LOG_LEVEL';
/** Env var the server reads its log file-tee target from. See {@link DEFAULT_LOG_LEVEL_ENV}. */
export const DEFAULT_LOG_FILE_ENV = 'HYDRANIUM_LOG_FILE';

/**
 * Human-readable formatting helpers used in log lines and diagnostic output.
 */
export namespace Format {
   /** Format a date as `HH:MM:SS.mmm`. Defaults to `now`. */
   export function timestamp(d: Date = new Date()): string {
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
   }

   /** Format a millisecond duration: `<1s` as `Nms`, `>=1s` as `N.NNs`. */
   export function elapsed(ms: number): string {
      return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
   }

   /** Format a byte count with a human-readable unit suffix (B/KB/MB/GB/TB). */
   export function bytes(count: number): string {
      if (count < 1024) {
         return `${count}B`;
      }
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = count / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
         value /= 1024;
         unit++;
      }
      return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${units[unit]}`;
   }
}
