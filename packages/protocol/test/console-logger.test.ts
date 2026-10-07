/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../src/console-logger';
import { Logger, type LogThreshold } from '../src/logger';

describe('ConsoleLogger', () => {
   let previous: LogThreshold;

   beforeEach(() => {
      previous = Logger.getLevel();
      Logger.setLevel('trace');
   });

   afterEach(() => {
      Logger.setLevel(previous);
      vi.restoreAllMocks();
   });

   it('writes each level to the matching console method, labelled and timestamped', () => {
      const methods = {
         error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
         warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
         info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
         debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      };
      const logger = new ConsoleLogger();

      logger.error('an error');
      logger.warn('a warning');
      logger.info('an info');
      logger.debug('a debug');
      logger.trace('a trace');

      expect(methods.error).toHaveBeenCalledWith(expect.stringMatching(/^\[Error - .+\] an error$/));
      expect(methods.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[Warn {2}- .+\] a warning$/));
      expect(methods.info).toHaveBeenCalledWith(expect.stringMatching(/^\[Info {2}- .+\] an info$/));
      expect(methods.debug).toHaveBeenNthCalledWith(1, expect.stringMatching(/^\[Debug - .+\] a debug$/));
      expect(methods.debug).toHaveBeenNthCalledWith(2, expect.stringMatching(/^\[Trace - .+\] a trace$/));
   });

   it('names the component a derived logger carries, and passes trailing arguments through', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const detail = { code: 42 };

      new ConsoleLogger().with('data head').error('a fault', detail);

      expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[Error - .+\] \[data head\] a fault$/), detail);
   });
});
