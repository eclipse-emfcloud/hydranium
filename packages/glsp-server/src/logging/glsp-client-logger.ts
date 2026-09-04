/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Logger as GlspLogger, LogLevel } from '@eclipse-glsp/server';
import { LspLogger, type LspLoggerOptions, type ServerSharedServices } from '@hydranium/core';
import { Logger, type LogThreshold } from '@hydranium/protocol';

/**
 * Options accepted by {@link GlspClientLogger}. Extends
 * {@link LspLoggerOptions} (which carries the optional `component`
 * label) with the GLSP-specific per-instance {@link logLevel} threshold.
 */
export interface GlspClientLoggerOptions extends LspLoggerOptions {
   /**
    * Per-instance NARROWING of the framework threshold. Omit it — the default
    * tracks `Logger.getLevel()` live, which is what makes one
    * `HYDRANIUM_LOG_LEVEL` / one LSP setting govern GLSP output too.
    *
    * It can only narrow, never widen, and that is not a policy choice:
    * `AbstractLogger.send` gates every emission on the process-wide threshold
    * before it reaches the output channel, so a value more verbose than the
    * global is silently ineffective. Set it only to make ONE component quieter
    * than the rest.
    */
   readonly logLevel?: LogLevel;
}

/**
 * Map the framework's {@link LogThreshold} onto GLSP's numeric enum.
 *
 * Two vocabularies have to meet here: ours is a string union with `'off'` and
 * `'trace'`, GLSP's a numeric enum whose most verbose tier is `debug`. `'off'`
 * becomes `none`, and **`'trace'` also becomes `debug`** — GLSP has no finer
 * tier, and mapping it to `none` would silence GLSP at the most verbose
 * framework setting, which is the opposite of what asking for `trace` means.
 */
export function glspLogLevelOf(threshold: LogThreshold): LogLevel {
   switch (threshold) {
      case 'off':
         return LogLevel.none;
      case 'error':
         return LogLevel.error;
      case 'warn':
         return LogLevel.warn;
      case 'info':
         return LogLevel.info;
      case 'debug':
      case 'trace':
         return LogLevel.debug;
   }
}

/**
 * Adapter from {@link LspLogger} (the framework's LSP-bound logger in
 * `@hydranium/core`) to GLSP's server-side {@link GlspLogger}
 * abstract base. Lets the GLSP container resolve a logger whose output
 * lines interleave with the LSP head's existing log channel — the only
 * way to debug request/response flow across the two heads in one place.
 *
 * GLSP-specific concerns layered on top of {@link LspLogger}:
 *
 * - A {@link logLevel} field, because GLSP's `Logger` contract declares one.
 *   **It tracks the framework's process-wide threshold by default**, resolving
 *   `Logger.getLevel()` through {@link glspLogLevelOf} on every read — so
 *   `HYDRANIUM_LOG_LEVEL`, the LSP log-level setting and the Theia preference
 *   all reach GLSP output without a second knob. Assigning the field (or
 *   passing `logLevel`) pins an explicit per-instance NARROWING; see
 *   {@link GlspClientLoggerOptions.logLevel} for why it cannot widen.
 *   Resolved lazily rather than captured in the constructor: the root logger is
 *   built during container setup, before the LSP client has sent its
 *   configuration, so a captured value would freeze the launch-time default.
 * - The {@link caller} accessor satisfies GLSP's abstract `Logger.caller`
 *   contract; it is backed by {@link LspLogger}'s `component` field.
 * - {@link info} / {@link warn} / {@link error} / {@link debug} accept GLSP's
 *   `(message, ...params)` shape and {@link combine} the params into the
 *   message via {@link formatParam} so objects render as JSON and errors
 *   render with stack. GLSP server code routinely calls
 *   `logger.error('Failed', error)` expecting the second argument to be
 *   surfaced in the log line.
 *
 * Subclasses can override {@link withUri} to render workspace-relative
 * paths instead of stringified URIs (the typical adopter customisation,
 * mirroring what an adopter does in its LSP-side logger).
 */
export class GlspClientLogger extends LspLogger implements GlspLogger {
   /**
    * Explicit per-instance narrowing, or `undefined` to track the framework
    * threshold. Kept separate from the resolved value so {@link derive} can pass
    * the OVERRIDE to children rather than the resolution — passing the resolved
    * level would pin every child at whatever the global happened to be when the
    * parent was derived, and container-time derivation is exactly when that
    * value is still the launch-time default.
    */
   protected logLevelOverride?: LogLevel;

   constructor(services: ServerSharedServices, options: GlspClientLoggerOptions = {}) {
      super(services, options);
      this.logLevelOverride = options.logLevel;
   }

   /** GLSP's `Logger.logLevel` contract; the framework threshold unless pinned. */
   get logLevel(): LogLevel {
      return this.logLevelOverride ?? glspLogLevelOf(Logger.getLevel());
   }

   set logLevel(level: LogLevel) {
      this.logLevelOverride = level;
   }

   /** GLSP's `Logger.caller` contract; reads {@link LspLogger.component}. */
   get caller(): string | undefined {
      return this.component;
   }

   override info(message: string, ...params: unknown[]): this {
      if (this.enabled(LogLevel.info)) {
         super.info(this.combine(message, params));
      }
      return this;
   }

   override warn(message: string, ...params: unknown[]): this {
      if (this.enabled(LogLevel.warn)) {
         super.warn(this.combine(message, params));
      }
      return this;
   }

   override error(message: string, ...params: unknown[]): this {
      if (this.enabled(LogLevel.error)) {
         super.error(this.combine(message, params));
      }
      return this;
   }

   override debug(message: string, ...params: unknown[]): this {
      if (this.enabled(LogLevel.debug)) {
         super.debug(this.combine(message, params));
      }
      return this;
   }

   /** True when {@link logLevel} permits emission at the given level. */
   protected enabled(level: LogLevel): boolean {
      return this.logLevel !== LogLevel.none && level <= this.logLevel;
   }

   /** Concatenate a message with its varargs, formatting each via {@link formatParam}. */
   protected combine(message: string, params: readonly unknown[]): string {
      return params.length === 0 ? message : `${message} ${params.map(p => this.formatParam(p)).join(',\n')}`;
   }

   /** Format a single param: errors → `message\nstack`; everything else → JSON.stringify(p, undefined, 4). */
   protected formatParam(param: unknown): string {
      if (param instanceof Error) {
         return `${param.message}\n${param.stack ?? ''}`;
      }
      try {
         return JSON.stringify(param, undefined, 4);
      } catch {
         return '';
      }
   }

   /**
    * Override of {@link LspLogger.derive} that carries the per-instance
    * narrowing. The base `derive(component)` constructs the subclass with
    * `{ component }` only, which would drop it.
    *
    * It passes {@link logLevelOverride}, NOT `this.logLevel`: an unpinned parent
    * must yield an unpinned child, or every derived logger freezes at the
    * threshold in force when the container was built.
    */
   protected override derive(component: string): this {
      const Subclass = this.constructor as new (services: ServerSharedServices, options?: GlspClientLoggerOptions) => this;
      return new Subclass(this.services, { logLevel: this.logLevelOverride, component });
   }
}
