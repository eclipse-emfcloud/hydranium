/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, SystemClock } from './clock';
import { Format, LEVEL_LABELS, type LogLevel, Logger, type LogThreshold } from './logger';

/** Default time source for every {@link AbstractLogger}; overridable per subclass via {@link AbstractLogger.clock}. */
const systemClock = new SystemClock();

/**
 * Cross-side abstract base for the {@link Logger} family. Centralises:
 *  - the {@link LogLevel}/{@link LogThreshold} contract and threshold gating;
 *  - public `error`/`warn`/`info`/`debug`/`trace`/`log` methods;
 *  - component-prefix derivation ({@link for}, {@link sub}, {@link with}, {@link withUri}).
 *
 * Emission only — measuring (timing, memory, profiling) lives on the
 * `Tracer`, which composes a Logger for its output.
 * Subclasses provide platform-specific output via {@link emit} and instance
 * creation via {@link derive}. Format is `[<Label> - HH:MM:SS.mmm]
 * [<component>] <message>` so client and server lines interleave cleanly under
 * one Output panel entry.
 */
export abstract class AbstractLogger implements Logger {
   constructor(protected component?: string) {}

   /**
    * Time source for this logger's timing helpers and timestamps. The base
    * returns the process-wide {@link SystemClock}; subclasses with access to
    * an injected {@link Clock} override this so logger time goes through the
    * same fake-clock axis as the rest of the framework's gated logic. Inherited
    * by derived loggers ({@link derive}), so a subclass override applies to its
    * children without any extra wiring.
    */
   protected clock(): Clock {
      return systemClock;
   }

   /** Render the current wall-clock instant as `HH:MM:SS.mmm`, sourced from {@link clock}. */
   protected timestamp(): string {
      return Format.timestamp(new Date(this.clock().now()));
   }

   error(message?: string, ...args: unknown[]): this {
      this.send('error', message, args);
      return this;
   }
   warn(message?: string, ...args: unknown[]): this {
      this.send('warn', message, args);
      return this;
   }
   info(message?: string, ...args: unknown[]): this {
      this.send('info', message, args);
      return this;
   }
   debug(message?: string, ...args: unknown[]): this {
      this.send('debug', message, args);
      return this;
   }
   /** High-volume diagnostic lines, only emitted when the log level is set to 'trace'. */
   trace(message?: string, ...args: unknown[]): this {
      this.send('trace', message, args);
      return this;
   }
   /** Info-level threshold rendered with the `Log` label instead of `Info`. */
   log(message?: string, ...args: unknown[]): this {
      this.send('info', message, args, 'Log');
      return this;
   }

   /** Emit `message` at `threshold`, or do nothing when `threshold === 'off'`. */
   logAt(threshold: LogThreshold, message: string): this {
      if (threshold === 'off') {
         return this;
      }
      return this[threshold](message);
   }

   /** Replace the component prefix with `component`. */
   for(component: string): this {
      return this.derive(component);
   }

   /** Append `component` to the existing prefix as a nested `parent :: child` segment. */
   sub(component: string): this {
      return this.derive(this.component ? `${this.component} :: ${component}` : component);
   }

   /** Append `component` as a separate bracket: `[a] [b]` rather than `[a :: b]`. */
   with(component: string): this {
      return this.derive(this.component ? `${this.component}] [${component}` : component);
   }

   /**
    * Default URI labelling: stringify the URI. Subclasses with workspace
    * awareness override to render workspace-relative paths.
    */
   withUri(uri: string): this {
      return this.with(uri);
   }

   /** Threshold-gated send. Subclasses can override the label by passing one explicitly. */
   protected send(level: LogLevel, message?: string, args: readonly unknown[] = [], label = LEVEL_LABELS[level]): void {
      if (!message || !Logger.isLevelEnabled(level)) {
         return;
      }
      this.emit(level, label, message, args);
   }

   /** Subclasses implement platform-specific output (console + file sink, OutputChannel, etc.). */
   protected abstract emit(level: LogLevel, label: string, message: string, args: readonly unknown[]): void;

   /** Subclasses construct a new instance preserving their constructor dependencies. */
   protected abstract derive(component: string): this;
}
