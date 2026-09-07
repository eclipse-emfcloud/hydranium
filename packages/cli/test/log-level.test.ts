/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_LEVEL_ENV } from '@hydranium/protocol';
import { logLevelEnv, parseLogLevelOption } from '../src/log-level.js';

describe('parseLogLevelOption', () => {
   it('accepts a valid threshold', () => {
      expect(parseLogLevelOption('debug')).toBe('debug');
   });

   it('normalises case', () => {
      expect(parseLogLevelOption('WARN')).toBe('warn');
   });

   it('throws a helpful error on an invalid value', () => {
      expect(() => parseLogLevelOption('debgu')).toThrow(/Invalid --log-level: debgu/);
   });
});

describe('logLevelEnv', () => {
   it('maps a threshold onto the env var the server reads', () => {
      expect(logLevelEnv('trace')).toEqual({ [DEFAULT_LOG_LEVEL_ENV]: 'trace' });
   });
});
