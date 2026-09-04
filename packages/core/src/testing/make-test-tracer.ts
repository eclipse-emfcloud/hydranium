/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, DefaultTracer, type Logger, type LogLevel, NoopLogger, SystemClock, type Tracer } from '@hydranium/protocol';

/**
 * No-op {@link Tracer} for tests — discards all output with real fluent
 * behaviour. Use to fill the `Tracer` slot of a hand-rolled fake services tree
 * when the test doesn't assert on emitted output. Equivalent to
 * `new DefaultTracer()` (which already defaults to a {@link NoopLogger} +
 * {@link SystemClock}); the named helper reads better at call sites and gives a
 * single place to evolve the test tracer.
 */
export function makeNoopTracer(): Tracer {
   return new DefaultTracer();
}

/**
 * No-op {@link Logger} for tests — discards all output with real fluent
 * behaviour (`for`/`sub`/`with` derive no-op children; `withUri`
 * short-circuits to the same instance). Use to fill
 * a `Logger` slot, or to satisfy a service/function that takes a bare `Logger`,
 * when the test doesn't assert on emitted output. Equivalent to
 * `new NoopLogger()`; the named helper is the bare-logger sibling of
 * {@link makeNoopTracer} and gives a single place to evolve the test logger.
 * Prefer this over hand-rolling a `{ for, sub, with, trace } as unknown as
 * Logger` stub — those omit methods and drift from the real surface.
 */
export function makeNoopLogger(): Logger {
   return new NoopLogger();
}

/** A captured emission: log level + rendered message. */
export interface CapturedLine {
   readonly level: LogLevel;
   readonly message: string;
}

/** A {@link Logger} whose emitted lines are captured for assertions. */
export interface CapturingLogger {
   readonly logger: Logger;
   /** Every line emitted through the logger (and its derived children), in order. */
   readonly lines: CapturedLine[];
}

/**
 * Capturing {@link Logger} for tests that assert on emitted output. Backed by a
 * complete {@link NoopLogger} subclass — so every emit method and `for`/`sub`/
 * `with`/`withUri` derivation works fluently — that records each emitted line
 * into {@link CapturingLogger.lines}. Derived child loggers share the same sink.
 * Emission is still threshold-gated, so set the level (`Logger.setLevel(...)`)
 * to the tier under test — `'trace'` captures everything. Prefer this over
 * hand-rolling a capturing `{ info, warn, ... } as unknown as Logger` stub.
 */
export function makeCapturingLogger(): CapturingLogger {
   const lines: CapturedLine[] = [];
   class Capturing extends NoopLogger {
      protected override emit(level: LogLevel, _label: string, message: string): void {
         lines.push({ level, message });
      }
      protected override derive(component: string): this {
         return new Capturing(component) as this;
      }
   }
   return { logger: new Capturing(), lines };
}

/** A {@link Tracer} whose emitted lines are captured for assertions. */
export interface CapturingTracer {
   readonly tracer: Tracer;
   /** Every line emitted through the tracer (and its derived children), in order. */
   readonly lines: CapturedLine[];
}

/**
 * Capturing {@link Tracer} for tests that assert on emitted output. Wraps a
 * {@link makeCapturingLogger} in a {@link DefaultTracer} so timing/profiling
 * lines are captured alongside plain log lines. Emission is threshold-gated, so
 * set the level (`Logger.setLevel(...)`) to the tier under test. Pass a
 * {@link Clock} to share the test's fake-time axis; defaults to
 * {@link SystemClock}.
 */
export function makeCapturingTracer(clock: Clock = new SystemClock()): CapturingTracer {
   const { logger, lines } = makeCapturingLogger();
   return { tracer: new DefaultTracer(logger, clock), lines };
}
