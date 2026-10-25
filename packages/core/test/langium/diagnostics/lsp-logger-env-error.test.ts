/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
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
// instance, and this one launches at `error`.
describe('a server launched at HYDRANIUM_LOG_LEVEL=error', () => {
   const tmpDir = mkdtempSync(join(tmpdir(), 'logger-env-error-test-'));
   const names = [DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV];
   const previous = names.map(name => process.env[name]);
   const entryLevel = Logger.getLevel();
   const quiet = (['error', 'warn', 'log', 'info', 'debug'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
   );
   const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

   afterAll(() => {
      quiet.forEach(spy => spy.mockRestore());
      stderr.mockRestore();
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

   it('writes its errors but no line announcing the level', () => {
      const path = join(tmpDir, 'server.log');
      installNodeLogFileSink();
      process.env[DEFAULT_LOG_FILE_ENV] = path;
      delete process.env[DEFAULT_LOG_FILE_LEVEL_ENV];
      process.env[DEFAULT_LOG_LEVEL_ENV] = 'error';
      Logger.setLevel('info');

      const logger = new LspLogger({ lsp: { Connection: undefined }, Clock: new SystemClock() } as unknown as ServerSharedServices);
      logger.error('after-launch');

      expect(Logger.getLevel()).toBe('error');
      const written = readFileSync(path, 'utf-8');
      expect(written).toContain('after-launch');
      expect(written).not.toContain('Log level');
      expect(quiet.flatMap(spy => spy.mock.calls).join('\n')).not.toContain('Log level');
      const toStderr = stderr.mock.calls.join('\n');
      expect(toStderr).toContain('after-launch');
      expect(toStderr).not.toContain('Log level');
   });
});
