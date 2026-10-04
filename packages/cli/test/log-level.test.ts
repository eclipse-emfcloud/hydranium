/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV } from '@hydranium/protocol';
import { logEnv, parseLogLevelOption } from '../src/log-level.js';

describe('parseLogLevelOption', () => {
   it('accepts a valid threshold', () => {
      expect(parseLogLevelOption('debug')).toBe('debug');
   });

   it('normalises case', () => {
      expect(parseLogLevelOption('WARN')).toBe('warn');
   });

   it('throws a helpful error on an invalid value, naming the flag', () => {
      expect(() => parseLogLevelOption('debgu')).toThrow(/Invalid --log-level: debgu/);
      expect(() => parseLogLevelOption('debgu', '--log-file-level')).toThrow(/Invalid --log-file-level: debgu/);
   });
});

describe('logEnv', () => {
   it('maps each log option onto the env var the server reads', () => {
      expect(logEnv({ logLevel: 'trace', logFile: '/logs/a.log', logFileLevel: 'debug' })).toEqual({
         [DEFAULT_LOG_LEVEL_ENV]: 'trace',
         [DEFAULT_LOG_FILE_ENV]: '/logs/a.log',
         [DEFAULT_LOG_FILE_LEVEL_ENV]: 'debug'
      });
   });

   it('sets only the variables given, and none when nothing is', () => {
      // An unset option leaves the child's inherited variable alone.
      expect(logEnv({ logFileLevel: 'debug' })).toEqual({ [DEFAULT_LOG_FILE_LEVEL_ENV]: 'debug' });
      expect(logEnv({})).toBeUndefined();
   });
});
