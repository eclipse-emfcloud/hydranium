/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger, type LogThreshold } from '@hydranium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServerDiagnostics } from '../../src/node/server-diagnostics.js';
import { makeCapturingLogger, makeNoopSharedServices } from '../../src/testing/index.js';

describe('startServerDiagnostics', () => {
   let priorLevel: LogThreshold;

   beforeEach(() => {
      priorLevel = Logger.getLevel();
      Logger.setLevel('trace');
   });
   afterEach(() => {
      Logger.setLevel(priorLevel);
   });

   it('describes the monitors in the preamble with the options they run with', () => {
      const { logger, lines } = makeCapturingLogger();
      const stop = startServerDiagnostics(makeNoopSharedServices({ Logger: logger }), {
         preamble: { productName: 'Probe', version: '0.0.0' },
         eventLoop: { thresholdMs: 200, intervalMs: 2000, snapshotAboveMs: 800 },
         memory: { warnThreshold: 0.7, criticalThreshold: 0.9 }
      });
      stop();

      const preamble = lines.map(line => line.message).join('\n');
      expect(preamble).toContain('a stall >=200ms is observed within a 2s window');
      expect(preamble).toContain('stalls >=800ms also trigger');
      expect(preamble).toContain('>=70% of V8 heap_size_limit');
      expect(preamble).toContain('>=90%');
   });
});
