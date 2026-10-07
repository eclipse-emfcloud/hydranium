/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { createGlspConnectionLogger } from '../src/index.js';
import { makeCapturingGlspLogger } from '../src/testing/index.js';

describe('createGlspConnectionLogger', () => {
   it("emits each connection level at the GLSP logger's matching level, and log at info", () => {
      const { logger, lines } = makeCapturingGlspLogger();
      const connectionLogger = createGlspConnectionLogger(logger);

      connectionLogger.error('error line');
      connectionLogger.warn('warn line');
      connectionLogger.info('info line');
      connectionLogger.log('log line');

      expect(lines).toEqual([
         { level: 'error', message: 'error line', params: [] },
         { level: 'warn', message: 'warn line', params: [] },
         { level: 'info', message: 'info line', params: [] },
         { level: 'info', message: 'log line', params: [] }
      ]);
   });
});
