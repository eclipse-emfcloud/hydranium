/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Starting the language server wraps the console for the log file again, for
 * a logger built before its connection: a stdio connection replaces
 * `console.error`, `warn`, `log` and `debug` when it is created, discarding
 * that logger's wrapper. A spy stands in for that replacement, since the real
 * one needs `--stdio` in the process's arguments.
 */

import { setLogFilePath } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeLspHarness } from '@hydranium/core/testing/node';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';

it('wraps the console again when the language server starts', () => {
   const dir = mkdtempSync(join(tmpdir(), 'order-flow-console-tee-'));
   const path = join(dir, 'server.log');
   const unwrapped = { error: console.error, warn: console.warn, info: console.info, log: console.log, debug: console.debug };
   // The first logger wraps the console, before the replacement below. The path
   // comes after it, since where HYDRANIUM_LOG_FILE is set, its env baseline
   // would replace an earlier one.
   void createOrderFlowServices({ ...NodeFileSystem }).shared.Logger;
   setLogFilePath(path, 'info');
   const replaced = vi.fn();
   console.warn = replaced;
   const harness = makeLspHarness({ createServices: connection => createOrderFlowServices({ connection, ...NodeFileSystem }).shared });
   try {
      console.warn('after-start');

      expect(readFileSync(path, 'utf-8')).toMatch(/^\[Warn {2}- [\d:.]+\] \[console\] after-start$/m);
      expect(replaced).toHaveBeenCalledWith('after-start');
   } finally {
      harness.dispose();
      Object.assign(console, unwrapped);
      setLogFilePath(undefined);
      rmSync(dir, { recursive: true, force: true });
   }
});
