/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV, Logger, SystemClock } from '@hydranium/protocol';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogFilePath, setLogFileSink } from '../../../src/langium/diagnostics/logger.js';
import { installNodeLogFileSink } from '../../../src/node/log-file-sink.js';
import { LspLogger } from '../../../src/langium/diagnostics/lsp-logger.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';

// Its own file because `LspLogger` applies the env baseline once per module
// instance: any earlier construction in the same file would already have read it.
describe('LspLogger HYDRANIUM_LOG_FILE_LEVEL baseline', () => {
   const tmpDir = mkdtempSync(join(tmpdir(), 'logger-env-test-'));
   const names = [DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV];
   const previous = names.map(name => process.env[name]);
   const entryLevel = Logger.getLevel();

   afterAll(() => {
      names.forEach((name, i) => {
         if (previous[i] === undefined) {
            delete process.env[name];
         } else {
            process.env[name] = previous[i];
         }
      });
      Logger.setLevel(entryLevel);
      setLogFilePath(undefined);
      setLogFileSink(undefined);
      rmSync(tmpDir, { recursive: true, force: true });
   });

   it('keeps the file at its own level after the setting applies', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const path = join(tmpDir, 'server.log');
      installNodeLogFileSink();
      process.env[DEFAULT_LOG_FILE_ENV] = path;
      process.env[DEFAULT_LOG_FILE_LEVEL_ENV] = 'debug';
      process.env[DEFAULT_LOG_LEVEL_ENV] = 'debug';
      Logger.setLevel('info');

      const logger = new LspLogger({ lsp: { Connection: undefined }, Clock: new SystemClock() } as unknown as ServerSharedServices, {
         logThreshold: 'info'
      });
      logger.debug('after-setting');

      const contents = readFileSync(path, 'utf-8');
      expect(contents).toContain(`Log file level debug (${DEFAULT_LOG_FILE_LEVEL_ENV})`);
      expect(contents).toContain('Log level debug → info (setting)');
      expect(contents).toContain('after-setting');
      expect(Logger.getLevel()).toBe('info');
   });
});
