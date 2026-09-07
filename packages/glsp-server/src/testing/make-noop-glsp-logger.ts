/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Logger as GlspLogger, NullLogger } from '@eclipse-glsp/server';

/**
 * No-op GLSP {@link GlspLogger} for tests — discards every message. GLSP's
 * `Logger` is an abstract class declaring `logLevel` / `caller` alongside the
 * emit methods, so an object literal never structurally satisfies it and each
 * test otherwise writes `{ info, warn, error, debug } as unknown as Logger`.
 * This returns GLSP's shipped {@link NullLogger}, so call sites fill a
 * `GlspLogger` slot cast-free — the GLSP-server sibling of `makeNoopLogger`.
 */
export function makeNoopGlspLogger(): GlspLogger {
   return new NullLogger();
}

/** GLSP emit level a {@link CapturedGlspLine} was recorded at. */
export type GlspLogLevel = 'info' | 'warn' | 'error' | 'debug';

/** A captured GLSP emission: level, rendered message, and trailing params. */
export interface CapturedGlspLine {
   readonly level: GlspLogLevel;
   readonly message: string;
   readonly params: readonly unknown[];
}

/** A GLSP {@link GlspLogger} whose emitted lines are captured for assertions. */
export interface CapturingGlspLogger {
   readonly logger: GlspLogger;
   /** Every line emitted through the logger, in order. */
   readonly lines: CapturedGlspLine[];
}

/**
 * Capturing GLSP {@link GlspLogger} for tests that assert on emitted output
 * (e.g. an error surfaced through the logger). Backed by a {@link NullLogger}
 * subclass so it is a complete `Logger`; each emit records into
 * {@link CapturingGlspLogger.lines}. Filter by `level` to assert on one tier —
 * `lines.filter(line => line.level === 'error')`. Prefer this over hand-rolling
 * an `{ error } as unknown as Logger` stub.
 */
export function makeCapturingGlspLogger(): CapturingGlspLogger {
   const lines: CapturedGlspLine[] = [];
   class Capturing extends NullLogger {
      override info(message: string, ...params: unknown[]): void {
         lines.push({ level: 'info', message, params });
      }
      override warn(message: string, ...params: unknown[]): void {
         lines.push({ level: 'warn', message, params });
      }
      override error(message: string, ...params: unknown[]): void {
         lines.push({ level: 'error', message, params });
      }
      override debug(message: string, ...params: unknown[]): void {
         lines.push({ level: 'debug', message, params });
      }
   }
   return { logger: new Capturing(), lines };
}
