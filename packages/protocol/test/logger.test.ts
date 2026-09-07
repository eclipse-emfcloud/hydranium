/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { AbstractLogger } from '../src/abstract-logger';
import { type LogLevel, Logger } from '../src/logger';

/** Minimal {@link AbstractLogger} that records every emitted line for assertions. */
class CapturingLogger extends AbstractLogger {
   readonly lines: { level: LogLevel; message: string }[] = [];
   protected emit(level: LogLevel, _label: string, message: string): void {
      this.lines.push({ level, message });
   }
   protected derive(component: string): this {
      return new CapturingLogger(component) as this;
   }
}

describe('Logger threshold gating', () => {
   afterEach(() => Logger.setLevel('info'));

   it('isLevelEnabled returns true for levels at or below the threshold', () => {
      Logger.setLevel('warn');
      expect(Logger.isLevelEnabled('error')).toBe(true);
      expect(Logger.isLevelEnabled('warn')).toBe(true);
      expect(Logger.isLevelEnabled('info')).toBe(false);
      expect(Logger.isLevelEnabled('debug')).toBe(false);
      expect(Logger.isLevelEnabled('trace')).toBe(false);
   });

   it('isLevelEnabled returns false for every level when threshold is off', () => {
      Logger.setLevel('off');
      expect(Logger.isLevelEnabled('error')).toBe(false);
      expect(Logger.isLevelEnabled('trace')).toBe(false);
   });

   it('isThresholdEnabled is false for off and otherwise tracks the level', () => {
      Logger.setLevel('warn');
      expect(Logger.isThresholdEnabled('off')).toBe(false);
      expect(Logger.isThresholdEnabled('error')).toBe(true);
      expect(Logger.isThresholdEnabled('warn')).toBe(true);
      expect(Logger.isThresholdEnabled('info')).toBe(false);
   });
});

describe('Logger.logAt', () => {
   afterEach(() => Logger.setLevel('info'));

   it('emits nothing and returns the logger when the threshold is off', () => {
      const logger = new CapturingLogger();
      const result = logger.logAt('off', 'ignored');
      expect(logger.lines).toEqual([]);
      expect(result).toBe(logger);
   });

   it('emits one line at the given level when the threshold permits', () => {
      Logger.setLevel('info');
      const logger = new CapturingLogger();
      logger.logAt('warn', 'hello');
      expect(logger.lines).toEqual([{ level: 'warn', message: 'hello' }]);
   });

   it('emits nothing when the current threshold suppresses that level', () => {
      Logger.setLevel('error');
      const logger = new CapturingLogger();
      logger.logAt('warn', 'hello');
      expect(logger.lines).toEqual([]);
   });
});
