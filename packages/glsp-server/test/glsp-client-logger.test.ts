/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { LogLevel } from '@eclipse-glsp/server/node.js';
import type { ServerSharedServices } from '@hydranium/core';
import { Logger, type LogThreshold } from '@hydranium/protocol';
import { GlspClientLogger, glspLogLevelOf } from '../src/logging/glsp-client-logger.js';

// These tests exercise only `combine` / `formatParam` / `enabled` / `derive`,
// none of which read the services tree (no `emit`, so no `Clock` access). A
// blank stub satisfies the type.
const stubServices = {} as ServerSharedServices;

class TestableGlspClientLogger extends GlspClientLogger {
   public testCombine(message: string, params: unknown[]): string {
      return this.combine(message, params);
   }
   public testFormatParam(param: unknown): string {
      return this.formatParam(param);
   }
   public testEnabled(level: LogLevel): boolean {
      return this.enabled(level);
   }
   public testDerive(component: string): this {
      return this.derive(component);
   }
}

describe('GlspClientLogger', () => {
   // The framework threshold is a process-global, so a test that moves it must
   // put it back or it leaks into every later suite in the same worker.
   const originalLevel = Logger.getLevel();
   afterEach(() => Logger.setLevel(originalLevel));

   describe('logLevel tracks the framework threshold', () => {
      it.each<[LogThreshold, LogLevel]>([
         ['off', LogLevel.none],
         ['error', LogLevel.error],
         ['warn', LogLevel.warn],
         ['info', LogLevel.info],
         ['debug', LogLevel.debug],
         // No finer GLSP tier exists; mapping to `none` would silence GLSP at
         // the most verbose framework setting, which inverts the request.
         ['trace', LogLevel.debug]
      ])('maps %s to the GLSP enum', (threshold, expected) => {
         expect(glspLogLevelOf(threshold)).toBe(expected);
      });

      it('reads the global when no override was passed', () => {
         const logger = new TestableGlspClientLogger(stubServices);

         Logger.setLevel('debug');
         expect(logger.logLevel).toBe(LogLevel.debug);
         expect(logger.testEnabled(LogLevel.debug)).toBe(true);

         // Resolved on READ, not captured at construction — the same instance
         // has to follow a later change, because the GLSP container builds its
         // logger before the LSP client has sent any configuration.
         Logger.setLevel('error');
         expect(logger.logLevel).toBe(LogLevel.error);
         expect(logger.testEnabled(LogLevel.debug)).toBe(false);
      });

      it('an explicit option pins the level against a later global change', () => {
         Logger.setLevel('debug');
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.error });

         expect(logger.logLevel).toBe(LogLevel.error);
         Logger.setLevel('trace');
         expect(logger.logLevel).toBe(LogLevel.error);
      });

      it('assigning the field pins an unpinned logger', () => {
         Logger.setLevel('debug');
         const logger = new TestableGlspClientLogger(stubServices);
         expect(logger.logLevel).toBe(LogLevel.debug);

         // GLSP's `Logger` contract declares `logLevel` mutable, so upstream
         // code may assign it; that has to win over the global.
         logger.logLevel = LogLevel.warn;
         Logger.setLevel('trace');
         expect(logger.logLevel).toBe(LogLevel.warn);
      });

      it('an unpinned parent derives an unpinned child', () => {
         Logger.setLevel('warn');
         const child = new TestableGlspClientLogger(stubServices).testDerive('Child');
         expect(child.logLevel).toBe(LogLevel.warn);

         // The trap this guards: `derive` passing the RESOLVED level would
         // freeze the child at whatever was in force during container setup,
         // so the child would ignore the configuration that arrives later.
         Logger.setLevel('debug');
         expect(child.logLevel).toBe(LogLevel.debug);
      });

      it('a pinned parent derives a pinned child', () => {
         Logger.setLevel('debug');
         const child = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.error }).testDerive('Child');

         expect(child.logLevel).toBe(LogLevel.error);
         Logger.setLevel('trace');
         expect(child.logLevel).toBe(LogLevel.error);
      });
   });

   describe('enabled()', () => {
      it('logs at info when level is info', () => {
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.info });
         expect(logger.testEnabled(LogLevel.info)).toBe(true);
         expect(logger.testEnabled(LogLevel.warn)).toBe(true);
         expect(logger.testEnabled(LogLevel.error)).toBe(true);
      });
      it('suppresses debug when level is info', () => {
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.info });
         expect(logger.testEnabled(LogLevel.debug)).toBe(false);
      });
      it('suppresses everything when level is none', () => {
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.none });
         expect(logger.testEnabled(LogLevel.error)).toBe(false);
         expect(logger.testEnabled(LogLevel.warn)).toBe(false);
         expect(logger.testEnabled(LogLevel.info)).toBe(false);
         expect(logger.testEnabled(LogLevel.debug)).toBe(false);
      });
   });

   describe('combine()', () => {
      const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.info });
      it('returns the bare message when there are no params', () => {
         expect(logger.testCombine('hello', [])).toBe('hello');
      });
      it('appends JSON-stringified objects', () => {
         expect(logger.testCombine('payload', [{ kind: 'foo', value: 42 }])).toBe('payload {\n    "kind": "foo",\n    "value": 42\n}');
      });
      it('formats errors with message and stack', () => {
         const error = new Error('boom');
         error.stack = 'Error: boom\n    at test';
         expect(logger.testCombine('Failed', [error])).toBe('Failed boom\nError: boom\n    at test');
      });
      it('joins multiple params with comma-newline', () => {
         expect(logger.testCombine('m', ['a', 'b'])).toBe('m "a",\n"b"');
      });
   });

   describe('formatParam()', () => {
      const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.info });
      it('returns empty string for unserialisable input (circular)', () => {
         const circular: { self?: unknown } = {};
         circular.self = circular;
         expect(logger.testFormatParam(circular)).toBe('');
      });
   });

   describe('derive()', () => {
      it('preserves logLevel across derived loggers', () => {
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.debug });
         const child = logger.testDerive('Child');
         expect(child).toBeInstanceOf(TestableGlspClientLogger);
         expect(child.logLevel).toBe(LogLevel.debug);
         expect(child.caller).toBe('Child');
      });
      it('chained derive does not corrupt the threshold', () => {
         const logger = new TestableGlspClientLogger(stubServices, { logLevel: LogLevel.warn });
         const child = logger.testDerive('A');
         const grandchild = child.with('B');
         expect(grandchild.logLevel).toBe(LogLevel.warn);
      });
   });
});
